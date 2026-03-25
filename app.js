const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 解析 explanation_image 欄位（向下相容單一字串 + JSON 陣列）
function parseExpImages(val) {
  if (!val) return [];
  try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr : [val]; }
  catch { return [val]; }
}

// 後台帳密（可直接修改）
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';

// 確保 uploads 目錄存在
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// 設定 multer 檔案上傳
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `question_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});
const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'explanation_image', maxCount: 20 }
]);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: 'quiz-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── 學生 API ───────────────────────────────────────────────

// 取得開放中的考試列表
app.get('/api/exams', (req, res) => {
  const exams = db.prepare(`
    SELECT e.id, e.name, e.description,
      COUNT(DISTINCT eg.group_id) as group_count,
      COUNT(DISTINCT q.id) as question_count
    FROM exams e
    LEFT JOIN exam_groups eg ON eg.exam_id = e.id
    LEFT JOIN questions q ON q.group_id = eg.group_id
    WHERE e.is_active = 1
    GROUP BY e.id
    ORDER BY e.id DESC
  `).all();
  res.json(exams);
});

// 取得某考試的所有題目（含題組資訊，不含正確答案）
app.get('/api/exams/:id/questions', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND is_active = 1').get(req.params.id);
  if (!exam) return res.status(404).json({ error: '考試不存在或已關閉' });

  const questions = db.prepare(`
    SELECT q.id, q.title, q.question_text, q.question_type, q.image_path,
           q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.option_f, q.is_optional,
           q.group_id, g.name as group_name,
           eg.sort_order as group_order
    FROM exam_groups eg
    JOIN question_groups g ON g.id = eg.group_id
    JOIN questions q ON q.group_id = eg.group_id
    WHERE eg.exam_id = ?
    ORDER BY eg.sort_order ASC, q.id ASC
  `).all(req.params.id);
  res.json(questions);
});

// 取得所有題目（不含正確答案，舊版相容）
app.get('/api/questions', (req, res) => {
  const questions = db.prepare(`
    SELECT id, title, question_text, question_type, image_path, option_a, option_b, option_c, option_d, option_e, option_f, is_optional
    FROM questions ORDER BY id ASC
  `).all();
  res.json(questions);
});

// 提交作答
app.post('/api/submit', (req, res) => {
  const { student_name, answers, exam_id } = req.body;
  if (!student_name || !answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: '資料不完整' });
  }

  const insert = db.prepare(`
    INSERT INTO answers (student_name, question_id, selected_answer, is_correct, exam_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  let correct = 0;
  const results = [];

  let requiredTotal = 0;
  let requiredCorrect = 0;

  const insertMany = db.transaction(() => {
    for (const ans of answers) {
      const q = db.prepare('SELECT correct_answer, is_optional, explanation, explanation_image, question_type FROM questions WHERE id = ?').get(ans.question_id);
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
      insert.run(student_name, ans.question_id, ans.selected_answer, isCorrect, exam_id || null);
      results.push({
        question_id: ans.question_id,
        selected: ans.selected_answer,
        correct_answer: q.correct_answer,
        is_correct: isCorrect === 1,
        is_optional: !!q.is_optional,
        explanation: q.explanation || null,
        explanation_images: parseExpImages(q.explanation_image),
        question_type: q.question_type || 'choice'
      });
    }
  });

  insertMany();

  const scoreBase = requiredTotal > 0 ? requiredTotal : answers.length;
  const scoreCorrect = requiredTotal > 0 ? requiredCorrect : correct;

  res.json({
    student_name,
    total: answers.length,
    required_total: requiredTotal,
    correct,
    required_correct: requiredCorrect,
    score: scoreBase > 0 ? Math.round((scoreCorrect / scoreBase) * 100) : 0,
    results
  });
});

// ─── 後台 API ───────────────────────────────────────────────

const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: '請先登入' });
};

// 後台登入
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '帳號或密碼錯誤' });
  }
});

// 後台登出
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 確認登入狀態
app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// 取得所有題目（含正確答案）
app.get('/api/admin/questions', requireAdmin, (req, res) => {
  const questions = db.prepare(`
    SELECT q.*, g.name as group_name
    FROM questions q
    LEFT JOIN question_groups g ON g.id = q.group_id
    ORDER BY q.id ASC
  `).all();
  res.json(questions);
});

// 新增題目
app.post('/api/admin/questions', requireAdmin, uploadFields, (req, res) => {
  const { title, question_text, question_type, option_a, option_b, option_c, option_d, option_e, option_f, correct_answer, is_optional, explanation, group_id } = req.body;
  if (!correct_answer) return res.status(400).json({ error: '請設定正確答案' });
  const qtype = question_type || 'choice';
  const image_path = req.files?.image?.[0] ? `/uploads/${req.files.image[0].filename}` : null;
  // 多張詳解圖片：合併新上傳 + 保留的舊圖
  const newExpFiles = (req.files?.explanation_image || []).map(f => `/uploads/${f.filename}`);
  const existingExp = req.body.existing_exp_images ? JSON.parse(req.body.existing_exp_images) : [];
  const allExpImages = [...existingExp, ...newExpFiles];
  const exp_image = allExpImages.length ? JSON.stringify(allExpImages) : null;
  const ans = qtype === 'choice' ? correct_answer.toUpperCase() : correct_answer;
  const result = db.prepare(`
    INSERT INTO questions (title, question_text, question_type, image_path, option_a, option_b, option_c, option_d, option_e, option_f, correct_answer, is_optional, explanation, explanation_image, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title || null, question_text || null, qtype, image_path,
         option_a || 'A', option_b || 'B', option_c || 'C', option_d || 'D',
         option_e || null, option_f || null,
         ans, is_optional === '1' ? 1 : 0, explanation || null, exp_image,
         group_id ? parseInt(group_id) : null);
  res.json({ id: result.lastInsertRowid, message: '題目新增成功' });
});

// 編輯題目
app.put('/api/admin/questions/:id', requireAdmin, uploadFields, (req, res) => {
  const { id } = req.params;
  const { title, question_text, question_type, option_a, option_b, option_c, option_d, option_e, option_f, correct_answer, is_optional, explanation, group_id } = req.body;
  const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '題目不存在' });

  const qtype = question_type || existing.question_type || 'choice';

  let image_path = existing.image_path;
  if (req.files?.image?.[0]) {
    if (existing.image_path) { const p = path.join(__dirname, existing.image_path); if (fs.existsSync(p)) fs.unlinkSync(p); }
    image_path = `/uploads/${req.files.image[0].filename}`;
  }

  // 多張詳解圖片：保留的舊圖 + 新上傳
  const existingExpImages = parseExpImages(existing.explanation_image);
  const keptExp = req.body.existing_exp_images ? JSON.parse(req.body.existing_exp_images) : existingExpImages;
  const newExpFiles = (req.files?.explanation_image || []).map(f => `/uploads/${f.filename}`);
  const allExpImages = [...keptExp, ...newExpFiles];
  // 清理被移除的舊檔案
  const removedImages = existingExpImages.filter(img => !keptExp.includes(img));
  removedImages.forEach(img => { const p = path.join(__dirname, img); if (fs.existsSync(p)) fs.unlinkSync(p); });
  const exp_image = allExpImages.length ? JSON.stringify(allExpImages) : null;

  const ans = correct_answer ? (qtype === 'choice' ? correct_answer.toUpperCase() : correct_answer) : existing.correct_answer;
  const gid = group_id !== undefined ? (group_id ? parseInt(group_id) : null) : existing.group_id;

  db.prepare(`
    UPDATE questions SET title=?, question_text=?, question_type=?, image_path=?, option_a=?, option_b=?, option_c=?, option_d=?, option_e=?, option_f=?, correct_answer=?, is_optional=?, explanation=?, explanation_image=?, group_id=?
    WHERE id=?
  `).run(title || null, question_text || null, qtype, image_path,
         option_a || 'A', option_b || 'B', option_c || 'C', option_d || 'D',
         option_e || null, option_f || null,
         ans, is_optional === '1' ? 1 : 0, explanation || null, exp_image, gid, id);

  res.json({ message: '題目更新成功' });
});

// 刪除題目
app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '題目不存在' });
  if (existing.image_path) {
    const imgPath = path.join(__dirname, existing.image_path);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
  // 清理多張詳解圖片
  parseExpImages(existing.explanation_image).forEach(img => {
    const p = path.join(__dirname, img);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  db.prepare('DELETE FROM answers WHERE question_id = ?').run(id);
  db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  res.json({ message: '題目刪除成功' });
});

// ─── 題組 API ───────────────────────────────────────────────

// 取得所有題組（含題目數量）
app.get('/api/admin/groups', requireAdmin, (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, COUNT(q.id) as question_count
    FROM question_groups g
    LEFT JOIN questions q ON q.group_id = g.id
    GROUP BY g.id
    ORDER BY g.sort_order ASC, g.id ASC
  `).all();
  res.json(groups);
});

// 新增題組
app.post('/api/admin/groups', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入題組名稱' });
  const result = db.prepare('INSERT INTO question_groups (name, description) VALUES (?, ?)').run(name, description || null);
  res.json({ id: result.lastInsertRowid, message: '題組新增成功' });
});

// 編輯題組
app.put('/api/admin/groups/:id', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入題組名稱' });
  db.prepare('UPDATE question_groups SET name=?, description=? WHERE id=?').run(name, description || null, req.params.id);
  res.json({ message: '題組更新成功' });
});

// 刪除題組
app.delete('/api/admin/groups/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  // 移除題目的題組關聯
  db.prepare('UPDATE questions SET group_id = NULL WHERE group_id = ?').run(id);
  // 移除考試題組關聯
  db.prepare('DELETE FROM exam_groups WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM question_groups WHERE id = ?').run(id);
  res.json({ message: '題組刪除成功' });
});

// 取得題組內的題目
app.get('/api/admin/groups/:id/questions', requireAdmin, (req, res) => {
  const questions = db.prepare('SELECT * FROM questions WHERE group_id = ? ORDER BY id ASC').all(req.params.id);
  res.json(questions);
});

// ─── 考試 API ───────────────────────────────────────────────

// 取得所有考試
app.get('/api/admin/exams', requireAdmin, (req, res) => {
  const exams = db.prepare(`
    SELECT e.*, COUNT(eg.id) as group_count
    FROM exams e
    LEFT JOIN exam_groups eg ON eg.exam_id = e.id
    GROUP BY e.id
    ORDER BY e.id DESC
  `).all();
  res.json(exams);
});

// 新增考試
app.post('/api/admin/exams', requireAdmin, (req, res) => {
  const { name, description, is_active } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入考試名稱' });
  const result = db.prepare('INSERT INTO exams (name, description, is_active) VALUES (?, ?, ?)').run(
    name, description || null, is_active === '0' ? 0 : 1
  );
  res.json({ id: result.lastInsertRowid, message: '考試新增成功' });
});

// 編輯考試
app.put('/api/admin/exams/:id', requireAdmin, (req, res) => {
  const { name, description, is_active } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入考試名稱' });
  db.prepare('UPDATE exams SET name=?, description=?, is_active=? WHERE id=?').run(
    name, description || null, is_active === '0' ? 0 : 1, req.params.id
  );
  res.json({ message: '考試更新成功' });
});

// 刪除考試
app.delete('/api/admin/exams/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM exam_groups WHERE exam_id = ?').run(req.params.id);
  db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);
  res.json({ message: '考試刪除成功' });
});

// 取得考試的題組列表
app.get('/api/admin/exams/:id/groups', requireAdmin, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.description, eg.sort_order,
      COUNT(q.id) as question_count
    FROM exam_groups eg
    JOIN question_groups g ON g.id = eg.group_id
    LEFT JOIN questions q ON q.group_id = eg.group_id
    WHERE eg.exam_id = ?
    GROUP BY eg.id
    ORDER BY eg.sort_order ASC
  `).all(req.params.id);
  res.json(groups);
});

// 更新考試的題組（覆蓋式）
app.post('/api/admin/exams/:id/groups', requireAdmin, (req, res) => {
  const { group_ids } = req.body; // array of group_id
  if (!Array.isArray(group_ids)) return res.status(400).json({ error: '格式錯誤' });
  const examId = req.params.id;
  db.prepare('DELETE FROM exam_groups WHERE exam_id = ?').run(examId);
  const insert = db.prepare('INSERT INTO exam_groups (exam_id, group_id, sort_order) VALUES (?, ?, ?)');
  db.transaction(() => {
    group_ids.forEach((gid, i) => insert.run(examId, gid, i));
  })();
  res.json({ message: '題組更新成功' });
});

// ─── 成績 API ───────────────────────────────────────────────

// 查看學生成績（支援 exam_id 篩選）
app.get('/api/admin/scores', requireAdmin, (req, res) => {
  const { exam_id } = req.query;
  let query, params;
  if (exam_id) {
    query = `
      SELECT
        a.student_name,
        COUNT(a.id) as total,
        SUM(a.is_correct) as correct,
        ROUND(SUM(a.is_correct) * 100.0 / COUNT(a.id)) as score,
        MAX(a.submitted_at) as last_submitted
      FROM answers a
      WHERE a.exam_id = ?
      GROUP BY a.student_name
      ORDER BY last_submitted DESC
    `;
    params = [exam_id];
  } else {
    query = `
      SELECT
        a.student_name,
        COUNT(a.id) as total,
        SUM(a.is_correct) as correct,
        ROUND(SUM(a.is_correct) * 100.0 / COUNT(a.id)) as score,
        MAX(a.submitted_at) as last_submitted
      FROM answers a
      GROUP BY a.student_name
      ORDER BY last_submitted DESC
    `;
    params = [];
  }
  res.json(db.prepare(query).all(...params));
});

// 查看特定學生的詳細作答（支援 exam_id 篩選）
app.get('/api/admin/scores/:name', requireAdmin, (req, res) => {
  const { exam_id } = req.query;
  let query, params;
  if (exam_id) {
    query = `
      SELECT a.*, q.title, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.option_f, q.correct_answer, q.image_path,
             q.group_id, g.name as group_name
      FROM answers a
      JOIN questions q ON a.question_id = q.id
      LEFT JOIN question_groups g ON g.id = q.group_id
      WHERE a.student_name = ? AND a.exam_id = ?
      ORDER BY a.submitted_at DESC, a.question_id ASC
    `;
    params = [req.params.name, exam_id];
  } else {
    query = `
      SELECT a.*, q.title, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.option_f, q.correct_answer, q.image_path,
             q.group_id, g.name as group_name
      FROM answers a
      JOIN questions q ON a.question_id = q.id
      LEFT JOIN question_groups g ON g.id = q.group_id
      WHERE a.student_name = ?
      ORDER BY a.submitted_at DESC, a.question_id ASC
    `;
    params = [req.params.name];
  }
  res.json(db.prepare(query).all(...params));
});

// 後台路由（SPA redirect）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`伺服器啟動：http://localhost:${PORT}`);
  console.log(`後台管理：http://localhost:${PORT}/admin`);
  console.log(`帳號：${ADMIN_USERNAME}  密碼：${ADMIN_PASSWORD}`);
});
