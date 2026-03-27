#!/usr/bin/env node
/** 補上失敗的 5 題填空題 */
const fs = require('fs');
const path = require('path');
const supabase = require('./database');

const STORAGE_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/images`;
const IMG_DIR = '/tmp/bebras_pdf';
const GROUP_ID = 3; // 已建立的 2022 Senior 題組

const FILL_QUESTIONS = [
  { num: 5,  title: '迷宮移動',     printPage: 17, answer: '18' },
  { num: 18, title: '草莓',         printPage: 53, answer: '23' },
  { num: 19, title: '拔河',         printPage: 57, answer: '3' },
  { num: 22, title: '重疊的村莊',   printPage: 65, answer: '5' },
  { num: 23, title: '給總統的禮物', printPage: 67, answer: '2' },
];

function questionFile(p) {
  return path.join(IMG_DIR, `right-${String((p - 3) / 2).padStart(2, '0')}.png`);
}
function explanationFile(p) {
  return path.join(IMG_DIR, `left-${String((p - 1) / 2).padStart(2, '0')}.png`);
}

async function uploadFile(localPath, folder) {
  const buffer = fs.readFileSync(localPath);
  const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
  const { error } = await supabase.storage.from('images').upload(filename, buffer, { contentType: 'image/png' });
  if (error) throw new Error(`上傳失敗: ${error.message}`);
  return `${STORAGE_URL}/${filename}`;
}

async function main() {
  for (const q of FILL_QUESTIONS) {
    const qFile = questionFile(q.printPage);
    const eFile = explanationFile(q.printPage);
    console.log(`上傳 Q${q.num} ${q.title}...`);

    const imageUrl = await uploadFile(qFile, 'questions');
    let expImageJson = null;
    if (fs.existsSync(eFile)) {
      const expUrl = await uploadFile(eFile, 'explanations');
      expImageJson = JSON.stringify([expUrl]);
    }

    const { data, error } = await supabase.from('questions').insert({
      title: q.title, question_text: null, question_type: 'fill',
      image_path: imageUrl, option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D',
      option_e: null, option_f: null, correct_answer: q.answer,
      is_optional: 0, explanation: null, explanation_image: expImageJson, group_id: GROUP_ID,
    }).select('id').single();

    if (error) console.log(`  [錯誤] ${error.message}`);
    else console.log(`  ✓ ID=${data.id} 答案=${q.answer}`);
  }
  console.log('完成！');
}

main().catch(e => { console.error(e.message); process.exit(1); });
