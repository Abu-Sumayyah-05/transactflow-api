// Runs after the walkthrough: copies the recording out of Playwright's
// scratch folder to docs/walkthrough.webm, where it is easy to find.
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  const root = path.join(__dirname, '.results', 'video');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.webm')) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  if (!found.length) return console.log('No video was recorded.');
  // The tour is the longest recording.
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const target = path.join(__dirname, '..', 'docs', 'walkthrough.webm');
  fs.copyFileSync(found[0], target);
  console.log(`Video saved to ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
};
