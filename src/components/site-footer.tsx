export function SiteFooter() {
  return (
    <footer className="border-t border-chakra-100 bg-chakra-900 text-chakra-100">
      <div className="tricolor-rule" />
      <div className="mx-auto max-w-6xl px-6 py-10 text-sm">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="font-semibold text-white">Baby Steps</span>
          <p className="text-chakra-300">
            © {new Date().getFullYear()} Baby Steps. One account for every
            product.
          </p>
        </div>
      </div>
    </footer>
  );
}
