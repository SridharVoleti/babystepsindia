import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-cream">
      <div className="tricolor-rule" />
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <Link href="/" className="mb-8 flex items-center gap-2">
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-chakra-600">
            <span className="h-2 w-2 rounded-full bg-chakra-600" />
          </span>
          <span className="text-lg font-bold tracking-tight text-chakra-900">
            Baby Steps
          </span>
        </Link>

        <div className="card w-full max-w-md p-8">{children}</div>
      </div>
    </div>
  );
}
