import Link from "next/link";

export default function LearningSessionReturnPage(){return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6">
  <h1 className="text-2xl font-semibold">Learning session complete</h1>
  <p className="mt-3 text-slate-700">Your acknowledged progress has been saved. You can safely close the learning app.</p>
  <Link className="mt-6 inline-flex min-h-11 items-center justify-center rounded bg-blue-700 px-5 text-white" href="/">
    Return to Baby Steps
  </Link>
 </main>;}
