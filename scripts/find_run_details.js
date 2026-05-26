const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/review-queue.db');
const db = new Database(dbPath);

const runs = db.prepare("SELECT * FROM agent_runs").all();

for (const run of runs) {
  let history = [];
  try {
    history = JSON.parse(run.history_json);
  } catch (err) {
    continue;
  }
  
  history.forEach((step, stepIdx) => {
    const stepStr = JSON.stringify(step);
    if (stepStr.toLowerCase().includes('aether')) {
      console.log(`\n==================================================`);
      console.log(`AGENT RUN MATCH: Run ID ${run.id}, Step ${stepIdx}`);
      console.log(`==================================================`);
      
      // Look for specific components containing 'aether'
      if (step.parts) {
        step.parts.forEach((part, partIdx) => {
          if (part.text && part.text.toLowerCase().includes('aether')) {
            console.log(`Part ${partIdx} text contains 'aether':`);
            console.log(part.text);
          }
          if (part.functionCall) {
            console.log(`Part ${partIdx} functionCall:`, JSON.stringify(part.functionCall, null, 2));
          }
          if (part.functionResponse) {
            const respStr = JSON.stringify(part.functionResponse);
            if (respStr.toLowerCase().includes('aether')) {
              console.log(`Part ${partIdx} functionResponse contains 'aether':`);
              if (part.functionResponse.name === 'search_x_tweets') {
                const tweets = part.functionResponse.response.tweets || [];
                tweets.forEach(tweet => {
                  if (JSON.stringify(tweet).toLowerCase().includes('aether')) {
                    console.log(`  Matching Tweet:`);
                    console.log(`    ID: ${tweet.id}`);
                    console.log(`    Author: ${tweet.authorHandle}`);
                    console.log(`    Bio: ${tweet.authorBio}`);
                    console.log(`    Text: ${tweet.text}`);
                  }
                });
              } else {
                console.log(JSON.stringify(part.functionResponse, null, 2));
              }
            }
          }
        });
      }
    }
  });
}

db.close();
