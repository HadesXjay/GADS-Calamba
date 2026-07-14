// ============================================================
// 1. Go to https://console.firebase.google.com → create a project
//    (name it anything, e.g. "gads-calamba")
// 2. In the project, click the </> (web) icon to register a web app
// 3. Firebase will show you a config object — paste it below,
//    replacing the placeholder values.
// 4. In the Firebase console, turn on:
//      Build > Authentication > Sign-in method > Email/Password
//      Build > Firestore Database > Create database (start in production mode)
// 5. Set ADMIN_EMAIL below to the email your mom will use to log in
//    as admin. She doesn't need to create this account manually —
//    the first time you deploy, follow the "Create the admin account"
//    step in README.md.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyBf_Q4DE8MHaS27sbiyHVWdkAwFSDklqoI",
  authDomain: "gads-15b87.firebaseapp.com",
  projectId: "gads-15b87",
  storageBucket: "gads-15b87.firebasestorage.app",
  messagingSenderId: "681306490691",
  appId: "1:681306490691:web:d9f002ec998e90f24cd1f6",
  measurementId: "G-Q3VHZCKRBR"
};


// This must exactly match the email of the one admin account (your mom's).
// It's also referenced in firestore.rules — if you change it here,
// change it there too, then redeploy the rules.
export const ADMIN_EMAIL = "jayvimp@gmail.com";
