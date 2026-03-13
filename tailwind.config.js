/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './App.{js,jsx,ts,tsx}',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        wolf: {
          bg: '#0F0F14',
          surface: '#1A1A24',
          card: '#22222F',
          accent: '#D4A017',
          red: '#B03A2E',
          text: '#F0EDE8',
          muted: '#8A8590',
        },
      },
    },
  },
  plugins: [],
};
