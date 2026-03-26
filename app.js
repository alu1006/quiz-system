const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const supabase = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase Storage 公開 URL 前綴
const STORAGE_URL = `${process.env.SUPABASE_URL || 'https://wrgsrmvctzfbmzbbyeuj.supabase.co'}/storage/v1/object/public/images`;

// 解析 explanation_image 欄位（向下相容單一字串 + JSON 陣列）
function parseExpImages(val) {
  if (!val) return [];
  try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr : [val]; }
  catch { return [val]; }
}

// 後台帳密（可用環境變數覆蓋）
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

    const scoreBase = requiredTotal > 0 ? requiredTotal : answers.length;
    const scoreCorrect = requiredTotal > 0 ? requiredCorrect : correct;

    res.json({
      student_name, total: answers.length,
      required_total: requiredTotal, correct, required_correct: requiredCorrect,
      score: scoreBase > 0 ? Math.round((scoreCorrect / scoreBase) * 100) : 0,
      results
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 後台 API ───────────────────────────────────────────────

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: '請先登入' });
};

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
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
  res.json({ isAdmin: !!req.session.isAdmin });
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

app.get('/api/admin/scores', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('student_name, is_correct, submitted_at, exam_id');
    if (exam_id) query = query.eq('exam_id', exam_id);
    const { data } = await query;

    // 手動聚合
    const map = {};
    (data || []).forEach(a => {
      if (!map[a.student_name]) map[a.student_name] = { student_name: a.student_name, total: 0, correct: 0, last_submitted: a.submitted_at };
      map[a.student_name].total++;
      if (a.is_correct) map[a.student_name].correct++;
      if (a.submitted_at > map[a.student_name].last_submitted) map[a.student_name].last_submitted = a.submitted_at;
    });

    const result = Object.values(map).map(s => ({
      ...s, score: s.total > 0 ? Math.round(s.correct * 100 / s.total) : 0
    }));
    result.sort((a, b) => b.last_submitted.localeCompare(a.last_submitted));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/scores/:name', requireAdmin, async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = supabase.from('answers').select('*').eq('student_name', req.params.name);
    if (exam_id) query = query.eq('exam_id', exam_id);
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
