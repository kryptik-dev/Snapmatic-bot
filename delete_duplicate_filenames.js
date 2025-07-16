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

async function deleteDuplicates() {
  let offset = 0;
  let allPhotos = [];
  while (true) {
    console.log(`Fetching records ${offset} to ${offset + BATCH_SIZE - 1}...`);
    let { data: photos, error } = await supabase
      .from('photos')
      .select('id, filename')
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) {
      console.error('Error fetching photos:', error.message);
      process.exit(1);
    }
    if (!photos || photos.length === 0) break;
    allPhotos = allPhotos.concat(photos);
    if (photos.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  const byFilename = {};
  for (const photo of allPhotos) {
    if (!byFilename[photo.filename]) byFilename[photo.filename] = [];
    byFilename[photo.filename].push(photo.id);
  }

  let totalDeleted = 0;
  for (const [filename, ids] of Object.entries(byFilename)) {
    if (ids.length > 1) {
      ids.sort((a, b) => a - b);
      const toDelete = ids.slice(1);
      for (const id of toDelete) {
        // First, delete likes referencing this photo
        const { error: likesError } = await supabase
          .from('likes')
          .delete()
          .eq('photo_id', id);
        if (likesError) {
          console.error(`Failed to delete likes for photo id ${id}:`, likesError.message);
          continue;
        }
        // Now, delete the photo
        const { error: delError } = await supabase
          .from('photos')
          .delete()
          .eq('id', id);
        if (delError) {
          console.error(`Failed to delete id ${id}:`, delError.message);
        } else {
          totalDeleted++;
          console.log(`Deleted duplicate id ${id} for filename ${filename}`);
        }
      }
    }
  }
  console.log(`Duplicate deletion complete. Deleted ${totalDeleted} records.`);
}

deleteDuplicates(); 