#!/usr/bin/env node
/**
 * 匯入 2022 Bebras 全部 4 組 (Benjamin, Cadet, Junior, Senior)
 * 使用方式: node import-2022-all.js
 */

const fs = require('fs');
const path = require('path');
const supabase = require('./database');

const STORAGE_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/images`;
const IMG_DIR = '/tmp/bebras_2022';

// ── 頁碼 → 圖片檔案 ─────────────────────────────────────────
function questionFile(printPage) {
  if (printPage % 2 === 1) {
    const k = (printPage - 3) / 2;
    return path.join(IMG_DIR, 'right', `right-${String(k).padStart(2, '0')}.png`);
  } else {
    const k = (printPage - 2) / 2;
    return path.join(IMG_DIR, 'left', `left-${String(k).padStart(2, '0')}.png`);
  }
}

function explanationFile(printPage) {
  if (printPage % 2 === 1) {
    const k = (printPage - 1) / 2;
    return path.join(IMG_DIR, 'left', `left-${String(k).padStart(2, '0')}.png`);
  } else {
    const k = printPage / 2;
    return path.join(IMG_DIR, 'left', `left-${String(k).padStart(2, '0')}.png`);
  }
}

// ── 全部 45 題 ────────────────────────────────────────────────
const ALL_QUESTIONS = {
  1:  { title: '樹林照片',         printPage: 7,   type: 'choice', answer: 'C' },
  2:  { title: '機器人工廠',       printPage: 11,  type: 'choice', answer: 'B' },
  3:  { title: '小美的社區',       printPage: 13,  type: 'fill',   answer: '4' },
  4:  { title: '連接海島',         printPage: 15,  type: 'fill',   answer: '44' },
  5:  { title: '迷宮移動',         printPage: 17,  type: 'fill',   answer: '18' },
  6:  { title: '滑雪道地圖',       printPage: 21,  type: 'choice', answer: 'C' },
  7:  { title: '海狸水壩',         printPage: 23,  type: 'choice', answer: 'D' },
  8:  { title: '生日派對',         printPage: 25,  type: 'choice', answer: 'C' },
  9:  { title: '排數字遊戲',       printPage: 27,  type: 'fill',   answer: '415236' },
  10: { title: '挑禮物',           printPage: 29,  type: 'choice', answer: 'D' },
  11: { title: '繽紛之塔',         printPage: 31,  type: 'choice', answer: 'A' },
  12: { title: '海狸資料庫',       printPage: 33,  type: 'choice', answer: 'C' },
  13: { title: '生成字串',         printPage: 35,  type: 'fill',   answer: '9' },
  14: { title: '漢堡食譜',         printPage: 39,  type: 'choice', answer: 'D' },
  15: { title: '海狸運動會',       printPage: 41,  type: 'fill',   answer: 'DFG' },
  16: { title: '石頭搬運',         printPage: 43,  type: 'choice', answer: 'B' },
  17: { title: '派對後大掃除',     printPage: 49,  type: 'choice', answer: 'C' },
  18: { title: '草莓',             printPage: 53,  type: 'fill',   answer: '23' },
  19: { title: '拔河',             printPage: 57,  type: 'fill',   answer: '3' },
  20: { title: '地鐵路線圖',       printPage: 59,  type: 'choice', answer: 'B' },
  21: { title: '飛機棚轉盤',       printPage: 63,  type: 'fill',   answer: '413625' },
  22: { title: '重疊的村莊',       printPage: 65,  type: 'fill',   answer: '5' },
  23: { title: '給總統的禮物',     printPage: 67,  type: 'fill',   answer: '2' },
  24: { title: '最喜愛的寶石',     printPage: 69,  type: 'fill',   answer: '10' },
  25: { title: '狸臉辨識',         printPage: 71,  type: 'fill',   answer: '5' },
  26: { title: '海狸餐廳',         printPage: 73,  type: 'choice', answer: 'A' },
  27: { title: '彩色蠟燭-題組一',  printPage: 76,  type: 'choice', answer: 'C' },
  28: { title: '彩色蠟燭-題組二',  printPage: 77,  type: 'choice', answer: 'A' },
  29: { title: '串列',             printPage: 79,  type: 'fill',   answer: '4' },
  30: { title: '水手項鍊',         printPage: 81,  type: 'choice', answer: 'D' },
  31: { title: '奧赫里德珍珠',     printPage: 83,  type: 'choice', answer: 'A' },
  32: { title: '貪夢的妖怪-題組一', printPage: 86, type: 'fill',   answer: '2313' },
  33: { title: '貪夢的妖怪-題組二', printPage: 87, type: 'choice', answer: 'D' },
  34: { title: '搭建房屋',         printPage: 89,  type: 'choice', answer: 'C' },
  35: { title: '泳池置物櫃',       printPage: 91,  type: 'choice', answer: 'A' },
  36: { title: '教室座位',         printPage: 93,  type: 'choice', answer: 'C' },
  37: { title: '電影之夜',         printPage: 95,  type: 'choice', answer: 'C' },
  38: { title: '切線遊戲',         printPage: 97,  type: 'choice', answer: 'B' },
  39: { title: '蜂巢之旅',         printPage: 101, type: 'choice', answer: 'B' },
  40: { title: '石頭篩選機',       printPage: 103, type: 'choice', answer: 'B' },
  41: { title: '服飾推薦系統',     printPage: 105, type: 'choice', answer: 'B' },
  42: { title: '井字遊戲',         printPage: 107, type: 'choice', answer: 'C' },
  43: { title: '螺帽和螺栓',       printPage: 109, type: 'choice', answer: 'C' },
  44: { title: '無人機路徑-題組一', printPage: 112, type: 'fill',   answer: '8' },
  45: { title: '無人機路徑-題組二', printPage: 113, type: 'choice', answer: 'C' },
};

// ── 4 個組別定義 ──────────────────────────────────────────────
const GROUP_DEFS = [
  {
    name: '2022 Benjamin',
    description: '2022 Bebras 運算思維挑戰賽 Benjamin 組（12 題）',
    questions: [1, 14, 34, 39, 8, 10, 40, 41, 3, 4, 18, 26],
  },
  {
    name: '2022 Cadet',
    description: '2022 Bebras 運算思維挑戰賽 Cadet 組（15 題）',
    questions: [8, 35, 36, 40, 41, 3, 4, 17, 18, 26, 9, 20, 22, 31, 33],
  },
  {
    name: '2022 Junior',
    description: '2022 Bebras 運算思維挑戰賽 Junior 組（15 題）',
    questions: [3, 6, 17, 29, 43, 7, 9, 20, 31, 42, 21, 22, 23, 33, 38],
  },
  {
    name: '2022 Senior',
    description: '2022 Bebras 運算思維挑戰賽 Senior 組（15 題）',
    questions: [7, 19, 31, 37, 42, 12, 15, 23, 32, 38, 5, 13, 16, 24, 44],
  },
];

// ── 上傳工具 ─────────────────────────────────────────────────
async function uploadFile(localPath, folder) {
  const buffer = fs.readFileSync(localPath);
  const ext = path.extname(localPath);
  const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage.from('images').upload(filename, buffer, {
    contentType: 'image/png',
  });
  if (error) throw new Error(`上傳失敗 ${localPath}: ${error.message}`);
  return `${STORAGE_URL}/${filename}`;
}

// ── 圖片快取（相同圖片只上傳一次）────────────────────────────
const imageCache = {};

async function uploadCached(localPath, folder) {
  if (imageCache[localPath]) return imageCache[localPath];
  const url = await uploadFile(localPath, folder);
  imageCache[localPath] = url;
  return url;
}

// ── 主程式 ───────────────────────────────────────────────────
async function main() {
  console.log('=== 開始匯入 2022 Bebras 全部 4 組 ===\n');

  // 先確認圖片目錄存在
  if (!fs.existsSync(path.join(IMG_DIR, 'right'))) {
    throw new Error(`找不到圖片目錄 ${IMG_DIR}/right — 請先執行 PDF 裁切`);
  }

  const groupIds = {};
  const examIds = {};

  // 1. 建立 4 個題組
  for (const g of GROUP_DEFS) {
    console.log(`建立題組: ${g.name}`);
    const { data, error } = await supabase.from('question_groups')
      .insert({ name: g.name, description: g.description })
      .select('id').single();
    if (error) throw error;
    groupIds[g.name] = data.id;
    console.log(`  題組 ID: ${data.id}`);
  }

  // 2. 逐組匯入題目
  for (const g of GROUP_DEFS) {
    console.log(`\n── ${g.name}（${g.questions.length} 題）──`);
    const gid = groupIds[g.name];

    for (const qNum of g.questions) {
      const q = ALL_QUESTIONS[qNum];
      if (!q) { console.log(`  [跳過] 找不到題目 #${qNum}`); continue; }

      const qFile = questionFile(q.printPage);
      const eFile = explanationFile(q.printPage);

      if (!fs.existsSync(qFile)) {
        console.log(`  [跳過] #${qNum} ${q.title} — 找不到 ${qFile}`);
        continue;
      }

      // 上傳題目圖片（快取）
      const imageUrl = await uploadCached(qFile, 'questions');

      // 上傳解答圖片（快取）
      let expImageJson = null;
      if (fs.existsSync(eFile)) {
        const expUrl = await uploadCached(eFile, 'explanations');
        expImageJson = JSON.stringify([expUrl]);
      }

      // 插入題目
      const { data: inserted, error: qErr } = await supabase.from('questions')
        .insert({
          title: q.title,
          question_text: null,
          question_type: q.type,
          image_path: imageUrl,
          option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D',
          option_e: null, option_f: null,
          correct_answer: q.answer,
          is_optional: 0,
          explanation: null,
          explanation_image: expImageJson,
          group_id: gid,
        }).select('id').single();

      if (qErr) {
        console.log(`  [錯誤] #${qNum} ${q.title}: ${qErr.message}`);
        continue;
      }
      console.log(`  ✓ #${qNum} ${q.title}  ID=${inserted.id}  答案=${q.answer} (${q.type})`);
    }
  }

  // 3. 建立 4 個考試並連結題組
  console.log('\n── 建立考試 ──');
  for (let i = 0; i < GROUP_DEFS.length; i++) {
    const g = GROUP_DEFS[i];
    const { data: exam, error: eErr } = await supabase.from('exams')
      .insert({ name: g.name, description: g.description, is_active: 1 })
      .select('id').single();
    if (eErr) throw eErr;
    examIds[g.name] = exam.id;

    const { error: egErr } = await supabase.from('exam_groups')
      .insert({ exam_id: exam.id, group_id: groupIds[g.name], sort_order: i });
    if (egErr) throw egErr;

    console.log(`  ✓ ${g.name}  考試ID=${exam.id}  題組ID=${groupIds[g.name]}`);
  }

  // 4. 統計
  const totalUploaded = Object.keys(imageCache).length;
  console.log(`\n=== 匯入完成 ===`);
  console.log(`  題組: ${GROUP_DEFS.length} 個`);
  console.log(`  考試: ${GROUP_DEFS.length} 個`);
  console.log(`  題目: ${GROUP_DEFS.reduce((s, g) => s + g.questions.length, 0)} 筆`);
  console.log(`  圖片: ${totalUploaded} 張（已快取去重）`);
}

main().catch(err => {
  console.error('匯入失敗:', err.message);
  process.exit(1);
});
