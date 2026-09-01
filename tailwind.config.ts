import type { Config } from "tailwindcss";

// Palette + type scale are anchored on brand/Babysteps_Design_Standard_Final_v1.0.docx.
// The named ramps are semantic: the dark end (700-900) is used for text on light
// surfaces and must hold AA contrast; the light end (50-200) is for fills, chips
// and borders. Brand anchors: chakra-600 = Babysteps Blue, chakra-700 = Deep Blue,
// green-600 = India Green, saffron-500 = Saffron.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Saffron — achievements, highlights, accent rules (#FF9933).
        saffron: {
          50: "#FFF6EC",
          100: "#FFEACC",
          200: "#FFD199",
          300: "#FFB666",
          400: "#FFA347",
          500: "#FF9933",
          600: "#F0821A",
          700: "#C96712",
          800: "#9C4F12",
          900: "#7A3F13",
        },
        // Green — success and completion, anchored on India Green (#138808).
        green: {
          50: "#EAF6E9",
          100: "#CBE9C7",
          200: "#A0D89A",
          300: "#6DC163",
          400: "#3DA531",
          500: "#1E8E12",
          600: "#138808",
          700: "#0F6E06",
          800: "#0C5305",
          900: "#083A03",
        },
        // Chakra blue — primary actions, brand identity, headings, dark surfaces.
        // 600 = Babysteps Blue #1565C0, 700 = Deep Blue #0D47A1.
        chakra: {
          50: "#ECF3FC",
          100: "#D2E3F7",
          200: "#A9C8EE",
          300: "#78A6E1",
          400: "#4480D0",
          500: "#2361B8",
          600: "#1565C0",
          700: "#0D47A1",
          800: "#0A356F",
          900: "#082450",
        },
        // Soft page background (#F7F9FC).
        cream: "#F7F9FC",
      },
      fontFamily: {
        sans: ['"Inter"', '"Noto Sans"', "system-ui", "-apple-system", "sans-serif"],
        heading: ['"Manrope"', '"Noto Sans"', "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
