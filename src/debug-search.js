import 'dotenv/config';
import { searchFiles } from './supabase.js';

const q = process.argv[2] || 'homepage';
searchFiles(q).then(rows => {
  console.log('Query:', q);
  console.log('Rows:', rows);
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
