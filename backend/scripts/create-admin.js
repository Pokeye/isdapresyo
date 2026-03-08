require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

function readPasswordFromStdin(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return reject(new Error('Password is required when stdin is not a TTY'));
    }

    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(promptText);

    let password = '';

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (ch) => {
      // Enter
      if (ch === '\r' || ch === '\n') {
        stdout.write('\n');
        cleanup();
        return resolve(password);
      }

      // Ctrl+C
      if (ch === '\u0003') {
        cleanup();
        return reject(new Error('Cancelled'));
      }

      // Backspace / Delete
      if (ch === '\b' || ch === '\u007f') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          // Move cursor back, erase, move back again
          stdout.write('\b \b');
        }
        return;
      }

      // Ignore other control chars
      if (ch < ' ' || ch === '\u007f') return;

      password += ch;
      stdout.write('*');
    };

    const cleanup = () => {
      stdin.off('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      stdin.pause();
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const username = process.argv[2];
  let password = process.argv[3];

  if (!username) {
    console.log('Usage: node scripts/create-admin.js <username> [password]');
    console.log('Tip: omit [password] to be prompted (safer).');
    process.exit(1);
  }

  if (!password) {
    password = await readPasswordFromStdin('Enter admin password: ');
  }

  if (!password) {
    console.error('Password is required.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO admin (username, password)
     VALUES ($1, $2)
     ON CONFLICT (username)
     DO UPDATE SET password = EXCLUDED.password`,
    [username, hash]
  );

  console.log(`Admin user "${username}" created/updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
