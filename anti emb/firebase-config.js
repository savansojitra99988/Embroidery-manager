// Google Firebase Configuration for Embroidery Manager Pro
// Replace these placeholders with your actual Firebase project settings.
// Detailed setup guide is available in your project files.

const firebaseConfig = {
  apiKey: "AIzaSyCT-nL31Gay06j4P4Y5b82mjwUu3Fw_Qew",
  authDomain: "embroidery-manager-fca6b.firebaseapp.com",
  projectId: "embroidery-manager-fca6b",
  storageBucket: "embroidery-manager-fca6b.firebasestorage.app",
  messagingSenderId: "1090251242484",
  appId: "1:1090251242484:web:6426d2a50bef81b1f657a1",
  measurementId: "G-ELY5RZDX1C"
};

// Helper function to check if the credentials have been configured by the user
function isFirebaseConfigured() {
    return firebaseConfig && 
           firebaseConfig.apiKey && 
           firebaseConfig.apiKey !== "YOUR_API_KEY" && 
           !firebaseConfig.apiKey.startsWith("YOUR_");
}
