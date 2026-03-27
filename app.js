require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const supabase = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Email 驗證碼（記憶體快取，格式：{ code, name, email, password, expires }）
const verifyCodeStore = {};

// 寄信設定（使用 Gmail SMTP）
const mailTransporter = process.env.SMTP_USER ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

// Supabase Storage 公開 URL 前綴
const STORAGE_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/images`;

// 解析 explanation_image 欄位（向下相容單一字串 + JSON 陣列）
function parseExpImages(val) {
  if (!val) return [];
  try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr : [val]; }
  catch { return [val]; }
}

// 後台帳密（可用環境變數覆蓋，作為備用登入）
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// multer 暫存到記憶體，再上傳到 Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});
const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'explanation_image', maxCount: 20 }
]);

// 上傳檔案到 Supabase Storage
async function uploadToStorage(file, folder) {
  const ext = path.extname(file.originalname);
  const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage.from('images').upload(filename, file.buffer, {
    contentType: file.mimetype
  });
  if (error) throw error;
  return `${STORAGE_URL}/${filename}`;
}

// 從 Supabase Storage 刪除檔案
async function deleteFromStorage(url) {
  if (!url || !url.includes('/storage/')) return;
  const filePath = url.split('/images/')[1];
  if (filePath) await supabase.storage.from('images').remove([filePath]);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'quiz-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── 學生會員 API ─────────────────────────────────────────────

// 註冊 - 步驟 1：寄驗證碼
app.post('/api/student/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: '請填寫姓名、Email 和密碼' });
    if (password.length < 4) return res.status(400).json({ error: '密碼至少 4 個字元' });

    const emailLower = email.toLowerCase().trim();
    const { data: existing } = await supabase.from('students').select('id').eq('email', emailLower).single();
    if (existing) return res.status(400).json({ error: '此 Email 已註冊，請直接登入' });

    // 產生 6 碼驗證碼
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await bcrypt.hash(password, 10);
    verifyCodeStore[emailLower] = { code, name, email: emailLower, password: hash, expires: Date.now() + 10 * 60 * 1000 };

    if (mailTransporter) {
      await mailTransporter.sendMail({
        from: `"Bebras 練習系統" <${process.env.SMTP_USER}>`,
        to: emailLower,
        subject: 'Bebras 練習系統 — 信箱驗證碼',
        html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:30px;border:1px solid #e0e0e0;border-radius:12px;">
          <h2 style="color:#2E3440;">Bebras 練習系統</h2>
          <p>Hi ${name}，你的驗證碼是：</p>
          <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#ECEFF4;border-radius:8px;color:#5E81AC;">${code}</div>
          <p style="color:#888;font-size:13px;margin-top:16px;">驗證碼 10 分鐘內有效。如果這不是你的操作，請忽略此信。</p>
        </div>`,
      });
      res.json({ success: true, needVerify: true });
    } else {
      // 沒設定 SMTP：跳過驗證直接註冊
      const { data, error } = await supabase.from('students')
        .insert({ name, email: emailLower, password: hash })
        .select('id, name, email').single();
      if (error) throw error;
      req.session.student = { id: data.id, name: data.name, email: data.email };
      res.json({ success: true, needVerify: false, student: { name: data.name, email: data.email } });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 註冊 - 步驟 2：驗證碼確認
app.post('/api/student/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    const emailLower = (email || '').toLowerCase().trim();
    const pending = verifyCodeStore[emailLower];
    if (!pending) return res.status(400).json({ error: '請先註冊' });
    if (Date.now() > pending.expires) { delete verifyCodeStore[emailLower]; return res.status(400).json({ error: '驗證碼已過期，請重新註冊' }); }
    if (pending.code !== code) return res.status(400).json({ error: '驗證碼錯誤' });

    // 驗證通過，建立帳號
    const { data, error } = await supabase.from('students')
      .insert({ name: pending.name, email: pending.email, password: pending.password })
      .select('id, name, email').single();
    if (error) throw error;
    delete verifyCodeStore[emailLower];

    req.session.student = { id: data.id, name: data.name, email: data.email };
    res.json({ success: true, student: { name: data.name, email: data.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 帳密登入
app.post('/api/student/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '請輸入 Email 和密碼' });

    const { data: student } = await supabase.from('students')
      .select('id, name, email, password').eq('email', email.toLowerCase()).single();
    if (!student || !student.password) return res.status(401).json({ error: 'Email 或密碼錯誤' });

    const match = await bcrypt.compare(password, student.password);
    if (!match) return res.status(401).json({ error: 'Email 或密碼錯誤' });

    req.session.student = { id: student.id, name: student.name, email: student.email };
    res.json({ success: true, student: { name: student.name, email: student.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Google 登入（學生）
app.post('/api/student/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential || !googleClient) return res.status(400).json({ error: '無法驗證 Google 帳號' });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    // 查找或建立帳號
    let { data: student } = await supabase.from('students')
      .select('id, name, email').eq('google_id', googleId).single();

    if (!student) {
      // 檢查 email 是否已存在（手動註冊過）
      const { data: byEmail } = await supabase.from('students')
        .select('id, name, email').eq('email', email.toLowerCase()).single();
      if (byEmail) {
        // 綁定 Google ID
        await supabase.from('students').update({ google_id: googleId }).eq('id', byEmail.id);
        student = byEmail;
      } else {
        // 新建帳號
        const { data: created, error } = await supabase.from('students')
          .insert({ name, email: email.toLowerCase(), google_id: googleId })
          .select('id, name, email').single();
        if (error) throw error;
        student = created;
      }
    }

    req.session.student = { id: student.id, name: student.name, email: student.email };
    res.json({ success: true, student: { name: student.name, email: student.email } });
  } catch (e) { res.status(401).json({ error: 'Google 驗證失敗: ' + e.message }); }
});

// 檢查登入狀態
app.get('/api/student/me', (req, res) => {
  if (req.session.student) {
    res.json({ loggedIn: true, student: req.session.student });
  } else {
    res.json({ loggedIn: false });
  }
});

// 登出
app.post('/api/student/logout', (req, res) => {
  delete req.session.student;
  res.json({ success: true });
});

// ─── 學生 API ───────────────────────────────────────────────

// 取得開放中的考試列表
app.get('/api/exams', async (req, res) => {
  try {
    // 先取得考試
    const { data: exams, error } = await supabase
      .from('exams').select('id, name, description').eq('is_active', 1).order('id', { ascending: false });
    if (error) throw error;

    // 對每個考試計算題目數
    for (const exam of exams) {
      const { data: groups } = await supabase
        .from('exam_groups').select('group_id').eq('exam_id', exam.id);
      const groupIds = (groups || []).map(g => g.group_id);
      if (groupIds.length) {
        const { count } = await supabase
          .from('questions').select('id', { count: 'exact', head: true }).in('group_id', groupIds);
        exam.question_count = count || 0;
      } else {
        exam.question_count = 0;
      }
    }
    res.json(exams);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 取得某考試的所有題目
app.get('/api/exams/:id/questions', async (req, res) => {
  try {
    const { data: exam } = await supabase
      .from('exams').select('*').eq('id', req.params.id).eq('is_active', 1).single();
    if (!exam) return res.status(404).json({ error: '考試不存在或已關閉' });

    const { data: egs } = await supabase
      .from('exam_groups').select('group_id, sort_order').eq('exam_id', req.params.id).order('sort_order');

    if (!egs || !egs.length) return res.json([]);

    const groupIds = egs.map(g => g.group_id);
    const groupOrder = {};
    egs.forEach(g => { groupOrder[g.group_id] = g.sort_order; });

    const { data: groups } = await supabase
      .from('question_groups').select('id, name').in('id', groupIds);
    const groupNames = {};
    (groups || []).forEach(g => { groupNames[g.id] = g.name; });

    const { data: questions } = await supabase
      .from('questions')
      .select('id, title, question_text, question_type, image_path, option_a, option_b, option_c, option_d, option_e, option_f, is_optional, group_id')
      .in('group_id', groupIds)
      .order('id');

    const result = (questions || []).map(q => ({
      ...q,
      group_name: groupNames[q.group_id] || null,
      group_order: groupOrder[q.group_id] || 0
    }));
    result.sort((a, b) => a.group_order - b.group_order || a.id - b.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 取得所有題目（舊版相容）
app.get('/api/questions', async (req, res) => {
  try {
    const { data } = await supabase
      .from('questions')
      .select('id, title, question_text, question_type, image_path, option_a, option_b, option_c, option_d, option_e, option_f, is_optional')
      .order('id');
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 提交作答
app.post('/api/submit', async (req, res) => {
  const { student_name, answers, exam_id } = req.body;
  if (!student_name || !answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: '資料不完整' });
  }

  try {
    const qIds = answers.map(a => a.question_id);
    const { data: qList } = await supabase
      .from('questions')
      .select('id, correct_answer, is_optional, explanation, explanation_image, question_type')
      .in('id', qIds);

    const qMap = {};
    (qList || []).forEach(q => { qMap[q.id] = q; });

    let correct = 0, requiredTotal = 0, requiredCorrect = 0;
    const results = [];
    const inserts = [];

    for (const ans of answers) {
      const q = qMap[ans.question_id];
      if (!q) continue;
      let isCorrect;
      if (q.question_type === 'fill') {
        isCorrect = (q.correct_answer || '').trim().toLowerCase() === (ans.selected_answer || '').trim().toLowerCase() ? 1 : 0;
      } else {
        isCorrect = q.correct_answer === ans.selected_answer ? 1 : 0;
      }
      if (isCorrect) correct++;
      if (!q.is_optional) {
        requiredTotal++;
        if (isCorrect) requiredCorrect++;
      }
      inserts.push({
        student_name, question_id: ans.question_id,
        selected_answer: ans.selected_answer, is_correct: isCorrect,
        exam_id: exam_id || null
      });
      results.push({
        question_id: ans.question_id, selected: ans.selected_answer,
        correct_answer: q.correct_answer, is_correct: isCorrect === 1,
        is_optional: !!q.is_optional, explanation: q.explanation || null,
        explanation_images: parseExpImages(q.explanation_image),
        question_type: q.question_type || 'choice'
      });
    }

    if (inserts.length) {
      const { error } = await supabase.from('answers').insert(inserts);
      if (error) throw error;
    }

    // 查詢該考試的全部必答題數作為分母
    let totalRequired = 0;
    if (exam_id) {
      const { data: egs } = await supabase.from('exam_groups').select('group_id').eq('exam_id', exam_id);
      const gids = (egs || []).map(g => g.group_id);
      if (gids.length) {
        const { count } = await supabase.from('questions').select('id', { count: 'exact', head: true }).in('group_id', gids).eq('is_optional', 0);
        totalRequired = count || 0;
      }
    }
    if (!totalRequired) totalRequired = requiredTotal || answers.length;

    res.json({
      student_name, total: answers.length,
      required_total: totalRequired, correct, required_correct: requiredCorrect,
      score: totalRequired > 0 ? Math.round((requiredCorrect / totalRequired) * 100) : 0,
      results
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 後台 API ───────────────────────────────────────────────

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: '請先登入' });
};

// Google 登入
app.post('/api/admin/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: '缺少 credential' });
    if (!googleClient) return res.status(500).json({ error: '伺服器未設定 GOOGLE_CLIENT_ID' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name || email;

    // 檢查是否為授權老師
    const { data: teacher } = await supabase.from('teachers')
      .select('id').eq('email', email).single();

    if (!teacher) {
      return res.status(403).json({ error: `${email} 不是授權的老師帳號` });
    }

    req.session.isAdmin = true;
    req.session.adminEmail = email;
    req.session.adminName = name;
    res.json({ success: true, name, email });
  } catch (e) {
    res.status(401).json({ error: 'Google 驗證失敗: ' + e.message });
  }
});

// 帳密登入（備用）
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.adminName = 'Admin';
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '帳號或密碼錯誤' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({
    isAdmin: !!req.session.isAdmin,
    name: req.session.adminName || null,
    email: req.session.adminEmail || null,
  });
});

// ─── 學生帳號 API ─────────────────────────────────────────────

app.get('/api/admin/students', requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from('students')
      .select('id, name, email, google_id, created_at')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  try {
    // 刪除該學生的作答記錄
    const { data: student } = await supabase.from('students').select('name').eq('id', req.params.id).single();
    if (student) await supabase.from('answers').delete().eq('student_name', student.name);
    const { error } = await supabase.from('students').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: '學生已刪除' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批次新增學生
app.post('/api/admin/students/batch', requireAdmin, async (req, res) => {
  try {
    const { students } = req.body;
    if (!Array.isArray(students) || !students.length) return res.status(400).json({ error: '無資料' });
    let added = 0, skipped = 0;
    for (const s of students) {
      if (!s.name) { skipped++; continue; }
      const row = { name: s.name, email: s.email ? s.email.toLowerCase().trim() : null };
      if (s.password && s.password.length >= 4) row.password = await bcrypt.hash(s.password, 10);
      if (row.email) {
        const { data: exists } = await supabase.from('students').select('id').eq('email', row.email).single();
        if (exists) { skipped++; continue; }
      }
      const { error } = await supabase.from('students').insert(row);
      if (error) { skipped++; continue; }
      added++;
    }
    res.json({ message: `新增 ${added} 筆，跳過 ${skipped} 筆（重複或格式錯誤）` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批次刪除學生
app.post('/api/admin/students/batch-delete', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未選取' });
    // 先刪作答記錄
    const { data: names } = await supabase.from('students').select('name').in('id', ids);
    if (names && names.length) {
      for (const n of names) await supabase.from('answers').delete().eq('student_name', n.name);
    }
    const { error } = await supabase.from('students').delete().in('id', ids);
    if (error) throw error;
    res.json({ message: `已刪除 ${ids.length} 筆學生` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 老師管理 API ─────────────────────────────────────────────

app.get('/api/admin/teachers', requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from('teachers').select('*').order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/teachers', requireAdmin, async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: '請輸入 Email' });
    const { data, error } = await supabase.from('teachers')
      .insert({ email: email.toLowerCase().trim(), name: name || null }).select('id').single();
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: '此 Email 已存在' });
      throw error;
    }
    res.json({ id: data.id, message: '老師新增成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/teachers/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('teachers').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: '老師已移除' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 取得所有題目（含正確答案）
app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const { data: questions } = await supabase
      .from('questions').select('*').order('id');

    // 取得題組名稱
    const groupIds = [...new Set((questions || []).map(q => q.group_id).filter(Boolean))];
    const groupNames = {};
    if (groupIds.length) {
      const { data: groups } = await supabase.from('question_groups').select('id, name').in('id', groupIds);
      (groups || []).forEach(g => { groupNames[g.id] = g.name; });
    }

    res.json((questions || []).map(q => ({ ...q, group_name: groupNames[q.group_id] || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增題目
app.post('/api/admin/questions', requireAdmin, uploadFields, async (req, res) => {
  try {
    const { title, question_text, question_type, option_a, option_b, option_c, option_d, option_e, option_f, correct_answer, is_optional, explanation, group_id } = req.body;
    if (!correct_answer) return res.status(400).json({ error: '請設定正確答案' });
    const qtype = question_type || 'choice';

    let image_path = null;
    if (req.files?.image?.[0]) {
      image_path = await uploadToStorage(req.files.image[0], 'questions');
    }

    const newExpFiles = [];
    for (const f of (req.files?.explanation_image || [])) {
      newExpFiles.push(await uploadToStorage(f, 'explanations'));
    }
    const existingExp = req.body.existing_exp_images ? JSON.parse(req.body.existing_exp_images) : [];
    const allExpImages = [...existingExp, ...newExpFiles];
    const exp_image = allExpImages.length ? JSON.stringify(allExpImages) : null;

    const ans = qtype === 'choice' ? correct_answer.toUpperCase() : correct_answer;

    const { data, error } = await supabase.from('questions').insert({
      title: title || null, question_text: question_text || null, question_type: qtype,
      image_path, option_a: option_a || 'A', option_b: option_b || 'B',
      option_c: option_c || 'C', option_d: option_d || 'D',
      option_e: option_e || null, option_f: option_f || null,
      correct_answer: ans, is_optional: is_optional === '1' ? 1 : 0,
      explanation: explanation || null, explanation_image: exp_image,
      group_id: group_id ? parseInt(group_id) : null
    }).select('id').single();
    if (error) throw error;

    res.json({ id: data.id, message: '題目新增成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 編輯題目
app.put('/api/admin/questions/:id', requireAdmin, uploadFields, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, question_text, question_type, option_a, option_b, option_c, option_d, option_e, option_f, correct_answer, is_optional, explanation, group_id } = req.body;

    const { data: existing } = await supabase.from('questions').select('*').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: '題目不存在' });

    const qtype = question_type || existing.question_type || 'choice';

    let image_path = existing.image_path;
    if (req.files?.image?.[0]) {
      if (existing.image_path) await deleteFromStorage(existing.image_path);
      image_path = await uploadToStorage(req.files.image[0], 'questions');
    }

    const existingExpImages = parseExpImages(existing.explanation_image);
    const keptExp = req.body.existing_exp_images ? JSON.parse(req.body.existing_exp_images) : existingExpImages;
    const newExpFiles = [];
    for (const f of (req.files?.explanation_image || [])) {
      newExpFiles.push(await uploadToStorage(f, 'explanations'));
    }
    const allExpImages = [...keptExp, ...newExpFiles];
    const removedImages = existingExpImages.filter(img => !keptExp.includes(img));
    for (const img of removedImages) await deleteFromStorage(img);
    const exp_image = allExpImages.length ? JSON.stringify(allExpImages) : null;

    const ans = correct_answer ? (qtype === 'choice' ? correct_answer.toUpperCase() : correct_answer) : existing.correct_answer;
    const gid = group_id !== undefined ? (group_id ? parseInt(group_id) : null) : existing.group_id;

    const { error } = await supabase.from('questions').update({
      title: title || null, question_text: question_text || null, question_type: qtype,
      image_path, option_a: option_a || 'A', option_b: option_b || 'B',
      option_c: option_c || 'C', option_d: option_d || 'D',
      option_e: option_e || null, option_f: option_f || null,
      correct_answer: ans, is_optional: is_optional === '1' ? 1 : 0,
      explanation: explanation || null, explanation_image: exp_image, group_id: gid
    }).eq('id', id);
    if (error) throw error;

    res.json({ message: '題目更新成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 刪除題目
app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: existing } = await supabase.from('questions').select('*').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: '題目不存在' });

    if (existing.image_path) await deleteFromStorage(existing.image_path);
    for (const img of parseExpImages(existing.explanation_image)) await deleteFromStorage(img);

    await supabase.from('answers').delete().eq('question_id', id);
    const { error } = await supabase.from('questions').delete().eq('id', id);
    if (error) throw error;

    res.json({ message: '題目刪除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 題組 API ───────────────────────────────────────────────

app.get('/api/admin/groups', requireAdmin, async (req, res) => {
  try {
    const { data: groups } = await supabase.from('question_groups').select('*').order('sort_order').order('id');
    for (const g of (groups || [])) {
      const { count } = await supabase.from('questions').select('id', { count: 'exact', head: true }).eq('group_id', g.id);
      g.question_count = count || 0;
    }
    res.json(groups || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/groups', requireAdmin, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: '請輸入題組名稱' });
    const { data, error } = await supabase.from('question_groups')
      .insert({ name, description: description || null }).select('id').single();
    if (error) throw error;
    res.json({ id: data.id, message: '題組新增成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/groups/:id', requireAdmin, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: '請輸入題組名稱' });
    const { error } = await supabase.from('question_groups')
      .update({ name, description: description || null }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: '題組更新成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/groups/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await supabase.from('questions').update({ group_id: null }).eq('group_id', id);
    await supabase.from('exam_groups').delete().eq('group_id', id);
    const { error } = await supabase.from('question_groups').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: '題組刪除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/groups/:id/questions', requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from('questions').select('*').eq('group_id', req.params.id).order('id');
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 考試 API ───────────────────────────────────────────────

app.get('/api/admin/exams', requireAdmin, async (req, res) => {
  try {
    const { data: exams } = await supabase.from('exams').select('*').order('id', { ascending: false });
    for (const e of (exams || [])) {
      const { count } = await supabase.from('exam_groups').select('id', { count: 'exact', head: true }).eq('exam_id', e.id);
      e.group_count = count || 0;
    }
    res.json(exams || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/exams', requireAdmin, async (req, res) => {
  try {
    const { name, description, is_active } = req.body;
    if (!name) return res.status(400).json({ error: '請輸入考試名稱' });
    const { data, error } = await supabase.from('exams')
      .insert({ name, description: description || null, is_active: is_active === '0' ? 0 : 1 })
      .select('id').single();
    if (error) throw error;
    res.json({ id: data.id, message: '考試新增成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/exams/:id', requireAdmin, async (req, res) => {
  try {
    const { name, description, is_active } = req.body;
    if (!name) return res.status(400).json({ error: '請輸入考試名稱' });
    const { error } = await supabase.from('exams')
      .update({ name, description: description || null, is_active: is_active === '0' ? 0 : 1 })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: '考試更新成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/exams/:id', requireAdmin, async (req, res) => {
  try {
    await supabase.from('exam_groups').delete().eq('exam_id', req.params.id);
    const { error } = await supabase.from('exams').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: '考試刪除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/exams/:id/groups', requireAdmin, async (req, res) => {
  try {
    const { data: egs } = await supabase.from('exam_groups')
      .select('group_id, sort_order').eq('exam_id', req.params.id).order('sort_order');
    if (!egs || !egs.length) return res.json([]);

    const groupIds = egs.map(g => g.group_id);
    const { data: groups } = await supabase.from('question_groups').select('*').in('id', groupIds);

    const result = [];
    for (const eg of egs) {
      const g = (groups || []).find(gr => gr.id === eg.group_id);
      if (!g) continue;
      const { count } = await supabase.from('questions').select('id', { count: 'exact', head: true }).eq('group_id', g.id);
      result.push({ id: g.id, name: g.name, description: g.description, sort_order: eg.sort_order, question_count: count || 0 });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/exams/:id/groups', requireAdmin, async (req, res) => {
  try {
    const { group_ids } = req.body;
    if (!Array.isArray(group_ids)) return res.status(400).json({ error: '格式錯誤' });
    const examId = parseInt(req.params.id);
    await supabase.from('exam_groups').delete().eq('exam_id', examId);
    if (group_ids.length) {
      const inserts = group_ids.map((gid, i) => ({ exam_id: examId, group_id: gid, sort_order: i }));
      const { error } = await supabase.from('exam_groups').insert(inserts);
      if (error) throw error;
    }
    res.json({ message: '題組更新成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 成績 API ───────────────────────────────────────────────

// 共用計分函數：按「學生 + 提交時間」分組
function computeScores(data, examTotal) {
  const map = {};
  (data || []).forEach(a => {
    const key = `${a.student_name}__${a.submitted_at}`;
    if (!map[key]) map[key] = { student_name: a.student_name, submitted_at: a.submitted_at, total: 0, correct: 0 };
    map[key].total++;
    if (a.is_correct) map[key].correct++;
  });
  return Object.values(map).map(s => {
    const base = examTotal || s.total;
    return { ...s, score: base > 0 ? Math.round(s.correct * 100 / base) : 0 };
  });
}

// 取得考試必答題總數
async function getExamTotal(exam_id) {
  if (!exam_id) return 0;
  const { data: egs } = await supabase.from('exam_groups').select('group_id').eq('exam_id', exam_id);
  const gids = (egs || []).map(g => g.group_id);
  if (!gids.length) return 0;
  const { count } = await supabase.from('questions').select('id', { count: 'exact', head: true }).in('group_id', gids).eq('is_optional', 0);
  return count || 0;
}

app.get('/api/admin/scores', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('student_name, is_correct, submitted_at, exam_id');
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { data } = await query;

    const examTotal = await getExamTotal(exam_id);
    const result = computeScores(data, examTotal);
    result.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/scores/:name', requireAdmin, async (req, res) => {
  try {
    const { exam_id, submitted_at } = req.query;
    let query = supabase.from('answers').select('*').eq('student_name', req.params.name);
    if (exam_id) query = query.eq('exam_id', exam_id);
    if (submitted_at) query = query.eq('submitted_at', submitted_at);
    const { data: answers } = await query.order('submitted_at', { ascending: false }).order('question_id');

    if (!answers || !answers.length) return res.json([]);

    const qIds = [...new Set(answers.map(a => a.question_id))];
    const { data: questions } = await supabase.from('questions')
      .select('id, title, option_a, option_b, option_c, option_d, option_e, option_f, correct_answer, image_path, group_id')
      .in('id', qIds);
    const qMap = {};
    (questions || []).forEach(q => { qMap[q.id] = q; });

    const groupIds = [...new Set((questions || []).map(q => q.group_id).filter(Boolean))];
    const groupNames = {};
    if (groupIds.length) {
      const { data: groups } = await supabase.from('question_groups').select('id, name').in('id', groupIds);
      (groups || []).forEach(g => { groupNames[g.id] = g.name; });
    }

    const result = answers.map(a => {
      const q = qMap[a.question_id] || {};
      return { ...a, title: q.title, option_a: q.option_a, option_b: q.option_b,
        option_c: q.option_c, option_d: q.option_d, option_e: q.option_e, option_f: q.option_f,
        correct_answer: q.correct_answer, image_path: q.image_path,
        group_id: q.group_id, group_name: groupNames[q.group_id] || null };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 題目錯誤率統計（依考試）
app.get('/api/admin/stats/errors', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('question_id, is_correct');
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { data } = await query;

    // 聚合每題的答對/答錯次數
    const map = {};
    (data || []).forEach(a => {
      if (!map[a.question_id]) map[a.question_id] = { question_id: a.question_id, total: 0, wrong: 0 };
      map[a.question_id].total++;
      if (!a.is_correct) map[a.question_id].wrong++;
    });

    const stats = Object.values(map).map(s => ({
      ...s, error_rate: s.total > 0 ? Math.round(s.wrong * 100 / s.total) : 0
    }));
    stats.sort((a, b) => b.error_rate - a.error_rate || b.wrong - a.wrong);

    // 補上題目資訊
    const qIds = stats.map(s => s.question_id);
    if (qIds.length) {
      const { data: questions } = await supabase.from('questions')
        .select('id, title, image_path, group_id').in('id', qIds);
      const qMap = {};
      (questions || []).forEach(q => { qMap[q.id] = q; });

      const groupIds = [...new Set((questions || []).map(q => q.group_id).filter(Boolean))];
      const groupNames = {};
      if (groupIds.length) {
        const { data: groups } = await supabase.from('question_groups').select('id, name').in('id', groupIds);
        (groups || []).forEach(g => { groupNames[g.id] = g.name; });
      }

      stats.forEach(s => {
        const q = qMap[s.question_id] || {};
        s.title = q.title || null;
        s.image_path = q.image_path || null;
        s.group_name = groupNames[q.group_id] || null;
      });
    }

    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 刪除學生成績
app.delete('/api/admin/scores/:name', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').delete().eq('student_name', req.params.name);
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { error } = await query;
    if (error) throw error;
    res.json({ message: `已刪除 ${req.params.name} 的成績` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 研究統計 API ───

// 成績分佈 + 進步曲線
app.get('/api/admin/stats/distribution', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('student_name, is_correct, submitted_at, exam_id');
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { data } = await query.range(0, 9999);
    const examTotal = await getExamTotal(exam_id);
    const scores = computeScores(data, examTotal);

    // 分佈：所有分數
    const distribution = scores.map(s => s.score);

    // 進步曲線：按學生分組，每人多次作答按時間排序
    const progress = {};
    scores.forEach(s => {
      if (!progress[s.student_name]) progress[s.student_name] = [];
      progress[s.student_name].push({ submitted_at: s.submitted_at, score: s.score });
    });
    Object.values(progress).forEach(arr => arr.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)));

    res.json({ distribution, progress });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 選項誘答力分析
app.get('/api/admin/stats/distractor', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('question_id, selected_answer');
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { data } = await query.range(0, 9999);

    const qIds = [...new Set((data || []).map(a => a.question_id))];
    if (!qIds.length) return res.json([]);

    const { data: questions } = await supabase.from('questions')
      .select('id, title, correct_answer, group_id, question_type').in('id', qIds);
    const qMap = {};
    (questions || []).forEach(q => { qMap[q.id] = q; });

    const groupIds = [...new Set((questions || []).map(q => q.group_id).filter(Boolean))];
    const groupNames = {};
    if (groupIds.length) {
      const { data: groups } = await supabase.from('question_groups').select('id, name').in('id', groupIds);
      (groups || []).forEach(g => { groupNames[g.id] = g.name; });
    }

    // 按題目統計各選項被選次數
    const map = {};
    (data || []).forEach(a => {
      if (!map[a.question_id]) map[a.question_id] = { total: 0, options: {} };
      map[a.question_id].total++;
      const ans = a.selected_answer || '?';
      map[a.question_id].options[ans] = (map[a.question_id].options[ans] || 0) + 1;
    });

    const result = qIds.map(qid => {
      const q = qMap[qid] || {};
      const s = map[qid] || { total: 0, options: {} };
      return {
        question_id: qid, title: q.title, correct_answer: q.correct_answer,
        question_type: q.question_type, group_name: groupNames[q.group_id] || null,
        total: s.total, options: s.options
      };
    });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 題目鑑別度 D-index
app.get('/api/admin/stats/discrimination', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('student_name, question_id, is_correct, submitted_at');
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { data } = await query.range(0, 9999);
    if (!data || !data.length) return res.json([]);

    const examTotal = await getExamTotal(exam_id);

    // 每位學生取最近一次作答的分數
    const studentScores = {};
    const scores = computeScores(data, examTotal);
    scores.forEach(s => {
      if (!studentScores[s.student_name] || s.submitted_at > studentScores[s.student_name].submitted_at) {
        studentScores[s.student_name] = s;
      }
    });

    const sorted = Object.values(studentScores).sort((a, b) => b.score - a.score);
    const n = sorted.length;
    const topN = Math.ceil(n * 0.27);
    if (topN === 0 || topN >= n) return res.json([]);

    const highGroup = new Set(sorted.slice(0, topN).map(s => s.student_name));
    const lowGroup = new Set(sorted.slice(n - topN).map(s => s.student_name));

    // 只取最近一次作答的答案
    const latestSubmit = {};
    data.forEach(a => {
      const key = a.student_name;
      if (!latestSubmit[key] || a.submitted_at > latestSubmit[key]) latestSubmit[key] = a.submitted_at;
    });
    const latestAnswers = data.filter(a => a.submitted_at === latestSubmit[a.student_name]);

    // 每題的鑑別度
    const qStats = {};
    latestAnswers.forEach(a => {
      if (!qStats[a.question_id]) qStats[a.question_id] = { hCorrect: 0, hTotal: 0, lCorrect: 0, lTotal: 0 };
      if (highGroup.has(a.student_name)) {
        qStats[a.question_id].hTotal++;
        if (a.is_correct) qStats[a.question_id].hCorrect++;
      }
      if (lowGroup.has(a.student_name)) {
        qStats[a.question_id].lTotal++;
        if (a.is_correct) qStats[a.question_id].lCorrect++;
      }
    });

    const qIds = Object.keys(qStats).map(Number);
    const { data: questions } = await supabase.from('questions')
      .select('id, title, group_id').in('id', qIds);
    const qMap = {};
    (questions || []).forEach(q => { qMap[q.id] = q; });

    const groupIds = [...new Set((questions || []).map(q => q.group_id).filter(Boolean))];
    const groupNames = {};
    if (groupIds.length) {
      const { data: groups } = await supabase.from('question_groups').select('id, name').in('id', groupIds);
      (groups || []).forEach(g => { groupNames[g.id] = g.name; });
    }

    const result = qIds.map(qid => {
      const s = qStats[qid];
      const q = qMap[qid] || {};
      const pH = s.hTotal > 0 ? s.hCorrect / s.hTotal : 0;
      const pL = s.lTotal > 0 ? s.lCorrect / s.lTotal : 0;
      return {
        question_id: qid, title: q.title, group_name: groupNames[q.group_id] || null,
        p_high: Math.round(pH * 100) / 100, p_low: Math.round(pL * 100) / 100,
        discrimination: Math.round((pH - pL) * 100) / 100,
        difficulty: Math.round((pH + pL) / 2 * 100) / 100
      };
    }).sort((a, b) => b.discrimination - a.discrimination);

    res.json({ data: result, student_count: n, warning: n < 10 ? '學生人數不足 10 人，鑑別度結果僅供參考' : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV 匯出
app.get('/api/admin/stats/export/:type', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    const type = req.params.type;
    const bom = '\uFEFF';

    if (type === 'scores') {
      let query = supabase.from('answers').select('student_name, is_correct, submitted_at, exam_id');
      if (exam_id) query = query.eq('exam_id', exam_id);
      const { data } = await query.range(0, 9999);
      const examTotal = await getExamTotal(exam_id);
      const scores = computeScores(data, examTotal);
      scores.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

      let csv = bom + '學生姓名,作答題數,答對題數,得分(%),提交時間\n';
      scores.forEach(s => {
        csv += `"${s.student_name}",${s.total},${s.correct},${s.score},"${s.submitted_at}"\n`;
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="scores_export.csv"');
      return res.send(csv);
    }

    if (type === 'answers') {
      let query = supabase.from('answers').select('student_name, question_id, selected_answer, is_correct, submitted_at');
      if (exam_id) query = query.eq('exam_id', exam_id);
      const { data } = await query.range(0, 9999).order('submitted_at', { ascending: false });

      const qIds = [...new Set((data || []).map(a => a.question_id))];
      let qMap = {};
      if (qIds.length) {
        const { data: questions } = await supabase.from('questions').select('id, title, correct_answer').in('id', qIds);
        (questions || []).forEach(q => { qMap[q.id] = q; });
      }

      let csv = bom + '學生姓名,題目ID,題目標題,選擇答案,正確答案,是否正確,提交時間\n';
      (data || []).forEach(a => {
        const q = qMap[a.question_id] || {};
        csv += `"${a.student_name}",${a.question_id},"${(q.title||'').replace(/"/g,'""')}","${a.selected_answer}","${q.correct_answer||''}",${a.is_correct ? '是' : '否'},"${a.submitted_at}"\n`;
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="answers_export.csv"');
      return res.send(csv);
    }

    res.status(400).json({ error: '無效的匯出類型，請使用 scores 或 answers' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Google Client ID（給前端用）
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// PDF 自學材料列表
app.get('/api/pdfs', (req, res) => {
  const pdfsDir = path.join(__dirname, 'public', 'pdfs');
  const fs = require('fs');
  if (!fs.existsSync(pdfsDir)) return res.json([]);
  const files = fs.readdirSync(pdfsDir).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
  res.json(files.map(f => ({ name: f.replace(/\.pdf$/i, ''), url: `/pdfs/${f}` })));
});

// 後台路由（SPA redirect）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`伺服器啟動：http://0.0.0.0:${PORT}`);
  console.log(`後台管理：http://0.0.0.0:${PORT}/admin`);
  console.log(`帳號：${ADMIN_USERNAME}  密碼：${ADMIN_PASSWORD}`);
});
