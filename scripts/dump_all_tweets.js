const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '../data/review-queue.db');
const db = new Database(dbPath);

const rows = db.prepare("SELECT id, profile_json FROM queue_items").all();
const outPath = '/Users/dmitriybelenkiy/.gemini/antigravity-ide/brain/200c070b-4ded-4733-9b54-c4e54d1dee69/scratch/all_tweets.txt';

let out = '';

for (const row of rows) {
  let profile = {};
  try {
    profile = JSON.parse(row.profile_json);
  } catch (err) {
    continue;
  }
  const company = profile.company || {};
  const rawContent = profile.rawContent || {};
  const tweets = rawContent.sourceTweets || [];
  
  out += `\nCompany: ${company.name} | X: ${company.xHandle} | Web: ${company.websiteUrl}\n`;
  tweets.forEach((t, i) => {
    out += `  Tweet ${i+1} by ${t.authorHandle}: ${t.text}\n`;
  });
  out += '='.repeat(80) + '\n';
}

fs.writeFileSync(outPath, out);
db.close();
console.log('Written all tweets to:', outPath);
