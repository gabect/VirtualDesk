import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import { getAnalytics, isSupported as analyticsIsSupported } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js';
import { getAuth, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBWEd7-QyMFKoovtdyWHICymP8-9KH2Djk',
  authDomain: 'virtual-desk-2e8a1.firebaseapp.com',
  projectId: 'virtual-desk-2e8a1',
  storageBucket: 'virtual-desk-2e8a1.firebasestorage.app',
  messagingSenderId: '1075800179675',
  appId: '1:1075800179675:web:b0da4b2463f0055feb9dfe',
  measurementId: 'G-YMM74MBCGW'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

analyticsIsSupported().then((supported) => {
  if (supported) getAnalytics(app);
}).catch(() => {});
