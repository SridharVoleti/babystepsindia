// Live console reporter: shows which test is running, every verification step as it
// happens, and a PASS / FAIL / SKIP verdict per test plus a summary table at the end.
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

// Only our own check() steps are interesting; hide Playwright's internal hooks/fixtures.
const isCheck = (s: TestStep) => s.category === "test.step";

export default class LiveReporter implements Reporter {
  private total = 0;
  private done = 0;
  private rows: { title: string; status: string; ms: number; checks: number }[] = [];
  private checks = new Map<TestCase, number>();

  onBegin(_config: unknown, suite: { allTests(): TestCase[] }) {
    this.total = suite.allTests().length;
    console.log(`\n${c.bold}${c.cyan}BabySteps automated user test${c.reset}  ${c.gray}(${this.total} tests)${c.reset}`);
    console.log(`${c.gray}Target: ${process.env.E2E_BASE_URL ?? "https://www.babystepsindia.com"}   Account: ${process.env.E2E_EMAIL}${c.reset}\n`);
  }

  onTestBegin(test: TestCase) {
    const n = this.done + 1;
    console.log(`${c.bold}[${n}/${this.total}] ▶ ${test.titlePath().slice(2).join(" › ")}${c.reset}`);
  }

  onStepEnd(test: TestCase, _r: TestResult, step: TestStep) {
    if (!isCheck(step)) return;
    this.checks.set(test, (this.checks.get(test) ?? 0) + 1);
    const ok = !step.error;
    console.log(`      ${ok ? c.green + "✔" : c.red + "✘"} ${step.title}${c.reset}${ok ? "" : `\n        ${c.red}${(step.error?.message ?? "").split("\n")[0]}${c.reset}`}`);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.done++;
    const skipped = result.status === "skipped";
    const passed = result.status === "passed";
    const label = skipped ? `${c.yellow}⊘ SKIPPED` : passed ? `${c.green}✔ PASSED` : `${c.red}✘ FAILED`;
    console.log(`    ${c.bold}${label}${c.reset} ${c.gray}(${(result.duration / 1000).toFixed(1)}s, ${this.checks.get(test) ?? 0} checks)${c.reset}`);
    if (skipped) {
      const why = test.annotations.find((a) => a.type === "skip")?.description;
      if (why) console.log(`      ${c.yellow}${why}${c.reset}`);
    }
    if (!passed && !skipped && result.error) {
      console.log(`      ${c.red}${(result.error.message ?? "").split("\n").slice(0, 4).join("\n      ")}${c.reset}`);
    }
    console.log("");
    this.rows.push({ title: test.titlePath().slice(2).join(" › "), status: result.status, ms: result.duration, checks: this.checks.get(test) ?? 0 });
  }

  onEnd(result: FullResult) {
    const pass = this.rows.filter((r) => r.status === "passed").length;
    const skip = this.rows.filter((r) => r.status === "skipped").length;
    const fail = this.rows.length - pass - skip;
    const checks = this.rows.reduce((a, r) => a + r.checks, 0);
    console.log(`${c.bold}${"═".repeat(72)}\nSUMMARY${c.reset}`);
    for (const r of this.rows) {
      const mark = r.status === "passed" ? `${c.green}PASS` : r.status === "skipped" ? `${c.yellow}SKIP` : `${c.red}FAIL`;
      console.log(`  ${mark}${c.reset}  ${r.title} ${c.gray}(${r.checks} checks)${c.reset}`);
    }
    console.log(`\n  ${c.green}${pass} passed${c.reset}   ${fail ? c.red : c.gray}${fail} failed${c.reset}   ${c.yellow}${skip} skipped${c.reset}   ${c.gray}${checks} individual checks verified${c.reset}`);
    console.log(`  ${result.status === "passed" ? c.green + "ALL TESTS PASSED" : c.red + "SOME TESTS FAILED"}${c.reset}`);
    console.log(`  ${c.gray}Detailed report: e2e-report\\index.html   (run: npx playwright show-report e2e-report)${c.reset}\n`);
  }
}
