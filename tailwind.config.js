/** @type {import('tailwindcss').Config} */
export default {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        surface: {
          900: '#0c0f14',
          800: '#12171f',
          700: '#1a2230',
          600: '#243044',
        },
        accent: {
          DEFAULT: '#ff3b5c',
          hover: '#ff5c78',
          muted: '#ff3b5c33',
        },
      },
      boxShadow: {
        glow: '0 0 40px -10px rgba(255, 59, 92, 0.45)',
      },
    },
  },
  plugins: [],
};
