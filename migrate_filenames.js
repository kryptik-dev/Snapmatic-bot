require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BATCH_SIZE = 1000;

async function migrate() {
  let offset = 0;
  let totalUpdated = 0;
  while (true) {
    console.log(`Fetching records ${offset} to ${offset + BATCH_SIZE - 1}...`);
    let { data: photos, error } = await supabase
      .from('photos')
      .select('id, filename, uploaderGamertag')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error('Error fetching photos:', error.message);
      process.exit(1);
    }
    if (!photos || photos.length === 0) break;

    let updated = 0;
    for (const photo of photos) {
      if (!photo.filename.includes('/')) {
        // Only update if not already migrated
        const newFilename = `snapmatic/${photo.uploaderGamertag}/${photo.filename}`;
        const { error: updateError } = await supabase
          .from('photos')
          .update({ filename: newFilename })
          .eq('id', photo.id);
        if (updateError) {
          console.error(`Failed to update id ${photo.id}:`, updateError.message);
        } else {
          updated++;
          console.log(`Updated id ${photo.id}: ${photo.filename} -> ${newFilename}`);
        }
      }
    }
    totalUpdated += updated;
    if (photos.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  console.log(`Migration complete. Updated ${totalUpdated} records.`);
}

migrate(); 