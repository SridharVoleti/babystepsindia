import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Saffron — primary / CTA
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
        // Green — shifted from the flag's yellow-olive green (#138808)
        // toward a fresher emerald/teal so it reads as a modern product
        // accent rather than a literal flag swatch.
        green: {
          50: "#EAFBF3",
          100: "#CCF5E1",
          200: "#99EBC3",
          300: "#5FDBA0",
          400: "#2EC384",
          500: "#10A374",
          600: "#0C8961",
          700: "#0A6E4E",
          800: "#0A583F",
          900: "#084835",
        },
        // Chakra navy — headings, footer, dark surfaces
        chakra: {
          50: "#EAF0FB",
          100: "#CBDBF5",
          200: "#9AB7EA",
          300: "#6690DC",
          400: "#3E6BC9",
          500: "#24509E",
          600: "#0B3D91",
          700: "#0A3277",
          800: "#092A63",
          900: "#082452",
        },
        cream: "#FFFDF9",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
