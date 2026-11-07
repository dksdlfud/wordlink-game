WORDLINK Render fix for flattened GitHub upload

The GitHub repository currently has all files flattened at its root.
Replace these files at the repository root:
- server.js
- package.json
- game-rules.test.js

Do NOT put them inside a new folder. Keep render.yaml, game-rules.js, index.html,
client.js, styles.css and words.json at the repository root as they are now.

The replacement server.js serves only index.html/styles.css/client.js, loads
words.json from the repository root, and imports game-rules.js from the root.
The replacement package.json starts `node server.js` instead of `node src/server.js`.

After committing, Render -> wordlink-game -> Manual Deploy -> Deploy latest commit.
