#!/usr/bin/env node
/**
 * 自動匯入 2022 Bebras PDF 考古題到 Supabase
 * 使用方式: node import-pdf.js
 */

const fs = require('fs');
const path = require('path');
const supabase = require('./database');

const STORAGE_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/images`;
const IMG_DIR = '/tmp/bebras_pdf';

// Senior 組 16 題
const SENIOR_QUESTIONS = [
  { num: 5,  title: '迷宮移動',     printPage: 17,  type: 'fill',   answer: '18' },
  { num: 6,  title: '滑雪道地圖',   printPage: 21,  type: 'choice', answer: 'C' },
  { num: 7,  title: '海狸水壩',     printPage: 23,  type: 'choice', answer: 'D' },
  { num: 11, title: '繽紛之塔',     printPage: 31,  type: 'choice', answer: 'A' },
  { num: 12, title: '海狸資料庫',   printPage: 33,  type: 'choice', answer: 'C' },
  { num: 14, title: '漢堡食譜',     printPage: 39,  type: 'choice', answer: 'D' },
  { num: 18, title: '草莓',         printPage: 53,  type: 'fill',   answer: '23' },
  { num: 19, title: '拔河',         printPage: 57,  type: 'fill',   answer: '3' },
  { num: 20, title: '地鐵路線圖',   printPage: 59,  type: 'choice', answer: 'B' },
  { num: 22, title: '重疊的村莊',   printPage: 65,  type: 'fill',   answer: '5' },
  { num: 23, title: '給總統的禮物', printPage: 67,  type: 'fill',   answer: '2' },
  { num: 30, title: '水手項鍊',     printPage: 81,  type: 'choice', answer: 'D' },
  { num: 36, title: '教室座位',     printPage: 93,  type: 'choice', answer: 'C' },
  { num: 37, title: '電影之夜',     printPage: 95,  type: 'choice', answer: 'C' },
  { num: 39, title: '蜂巢之旅',     printPage: 101, type: 'choice', answer: 'B' },
  { num: 42, title: '井字遊戲',     printPage: 107, type: 'choice', answer: 'C' },
];

// 印刷頁碼 → 裁切檔案名稱
// PDF page 2 = printed pages 6(left), 7(right)
// PDF page K: left = 2K+2, right = 2K+3
function questionFile(printPage) {
  // printPage 是奇數 → right half
  const k = (printPage - 3) / 2;
  return path.join(IMG_DIR, `right-${String(k).padStart(2, '0')}.png`);
}

function explanationFile(printPage) {
  // 答案在 printPage+1 (偶數) → left half
  const k = (printPage + 1 - 2) / 2;
  return path.join(IMG_DIR, `left-${String(k).padStart(2, '0')}.png`);
}

async function uploadFile(localPath, folder) {
  const buffer = fs.readFileSync(localPath);
  const ext = path.extname(localPath);
  const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage.from('images').upload(filename, buffer, {
    contentType: 'image/png'
  });
  if (error) throw new Error(`上傳失敗 ${localPath}: ${error.message}`);
  return `${STORAGE_URL}/${filename}`;
}

async function main() {
  console.log('=== 開始匯入 2022 Senior 題目 ===\n');

  // 1. 建立題組
  console.log('建立題組: 2022 Senior');
  const { data: group, error: gErr } = await supabase.from('question_groups')
    .insert({ name: '2022 Senior', description: '2022 Bebras 運算思維挑戰賽 Senior 組' })
    .select('id').single();
  if (gErr) throw gErr;
  const groupId = group.id;
  console.log(`  題組 ID: ${groupId}\n`);

  // 2. 逐題上傳
  for (const q of SENIOR_QUESTIONS) {
    const qFile = questionFile(q.printPage);
    const eFile = explanationFile(q.printPage);

    if (!fs.existsSync(qFile)) {
      console.log(`  [跳過] Q${q.num} ${q.title} — 找不到題目圖片 ${qFile}`);
      continue;
    }

    console.log(`  上傳 Q${q.num} ${q.title}...`);

    // 上傳題目圖片
    const imageUrl = await uploadFile(qFile, 'questions');

    // 上傳詳解圖片
    let expImageJson = null;
    if (fs.existsSync(eFile)) {
      const expUrl = await uploadFile(eFile, 'explanations');
      expImageJson = JSON.stringify([expUrl]);
    }

    // 插入題目
    const questionData = {
      title: q.title,
      question_text: null,
      question_type: q.type,
      image_path: imageUrl,
      option_a: 'A',
      option_b: 'B',
      option_c: 'C',
      option_d: 'D',
      option_e: null,
      option_f: null,
      correct_answer: q.answer,
      is_optional: 0,
      explanation: null,
      explanation_image: expImageJson,
      group_id: groupId,
    };

    const { data: inserted, error: qErr } = await supabase.from('questions')
      .insert(questionData).select('id').single();
    if (qErr) {
      console.log(`    [錯誤] ${qErr.message}`);
      continue;
    }
    console.log(`    ✓ ID=${inserted.id} 答案=${q.answer} (${q.type})`);
  }

  // 3. 建立考試
  console.log('\n建立考試: 2022 Senior');
  const { data: exam, error: eErr } = await supabase.from('exams')
    .insert({ name: '2022 Senior', description: '2022 Bebras 運算思維挑戰賽 Senior 組', is_active: 1 })
    .select('id').single();
  if (eErr) throw eErr;
  console.log(`  考試 ID: ${exam.id}`);

  // 4. 連結題組到考試
  const { error: egErr } = await supabase.from('exam_groups')
    .insert({ exam_id: exam.id, group_id: groupId, sort_order: 0 });
  if (egErr) throw egErr;
  console.log('  ✓ 題組已連結\n');

  console.log('=== 匯入完成 ===');
}

main().catch(err => {
  console.error('匯入失敗:', err.message);
  process.exit(1);
});
