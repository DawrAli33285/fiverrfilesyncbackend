

import 'dotenv/config';

const BASE_URL = (process.env.SEAZONA_BASE_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.SEAZONA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SEAZONA_CLIENT_SECRET || '';

if (!BASE_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SEAZONA_BASE_URL, SEAZONA_CLIENT_ID, or SEAZONA_CLIENT_SECRET.');
  console.error('Make sure .env is in this same folder and contains all three.');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function main() {
  const res = await fetch(`${BASE_URL}/users/`, {
    method: 'GET',
    headers: {
      Authorization: auth,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Request failed: ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  const users = await res.json();

  if (!Array.isArray(users) || users.length === 0) {
    console.log('No users returned.');
    return;
  }

  console.log(`Found ${users.length} lab user(s):\n`);
  console.log('userId'.padEnd(38), 'Name'.padEnd(30), 'Email');
  console.log('-'.repeat(90));
  for (const u of users) {
    const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
    console.log(
      (u.id || '').padEnd(38),
      name.padEnd(30),
      u.email || ''
    );
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});