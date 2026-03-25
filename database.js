const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'quiz.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    image_path TEXT,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct_answer TEXT NOT NULL,
    is_optional INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name TEXT NOT NULL,
    question_id INTEGER NOT NULL,
    selected_answer TEXT NOT NULL,
    is_correct INTEGER NOT NULL,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );

  CREATE TABLE IF NOT EXISTS question_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exam_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (exam_id) REFERENCES exams(id),
    FOREIGN KEY (group_id) REFERENCES question_groups(id)
  );
`);

// 安全地新增欄位（若已存在則略過）
const addColumnIfNotExists = (table, column, definition) => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // 欄位已存在，略過
  }
};

addColumnIfNotExists('questions', 'question_text', 'TEXT');
addColumnIfNotExists('questions', 'question_type', "TEXT NOT NULL DEFAULT 'choice'");
addColumnIfNotExists('questions', 'explanation', 'TEXT');
addColumnIfNotExists('questions', 'explanation_image', 'TEXT');
addColumnIfNotExists('questions', 'group_id', 'INTEGER');
addColumnIfNotExists('questions', 'option_e', 'TEXT');
addColumnIfNotExists('questions', 'option_f', 'TEXT');
addColumnIfNotExists('answers', 'exam_id', 'INTEGER');

module.exports = db;
