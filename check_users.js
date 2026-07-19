import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
admin.initializeApp({
  projectId: 'ff-store-4a61e'
});

const db = admin.firestore();

async function run() {
  try {
    console.log("Fetching users collection...");
    const snap = await db.collection('users').get();
    console.log(`Found ${snap.size} users:`);
    snap.forEach(doc => {
      const data = doc.data();
      console.log(`ID: ${doc.id} | Email: ${data.email} | Role: ${data.role} | Status: ${data.status}`);
    });
  } catch (err) {
    console.error("Error reading users:", err);
  }
}

run();
