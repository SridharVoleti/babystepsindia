// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Hero } from "@/components/hero";
import { SiteHeader } from "@/components/site-header";
import { ProductCatalog } from "@/components/product-catalog";

vi.mock("@/lib/db/products", () => ({
  listProducts: vi.fn(async () => [
    { slug: "magical-math", subdomain: "math.example.test" },
    { slug: "chess", subdomain: "chess.example.test" },
    { slug: "speed-reading", subdomain: "read.example.test" },
  ]),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));
vi.mock("@/lib/db/subscriptions", () => ({ getEntitlementsForUser: vi.fn() }));

describe("Babysteps public homepage", () => {
  it("makes the core promise and parent registration action unmistakable", () => {
    render(<><SiteHeader /><Hero /></>);
    expect(screen.getByRole("heading", { level: 1, name: "Turn Screen Time into Skill Time" })).toBeInTheDocument();
    expect(screen.getByLabelText("Babysteps")).toHaveTextContent("babysteps");
    expect(screen.getAllByRole("link", { name: /Start Your Child's Journey/i })[0]).toHaveAttribute("href", "/signup");
  });

  it("presents three real featured apps while keeping discovery-only apps non-purchasable", async () => {
    render(await ProductCatalog());
    for (const name of ["Magical Math", "Chess Master", "Speed Reading"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    const ecosystem = screen.getByLabelText("Babysteps learning app ecosystem");
    for (const name of ["Olympiad Math", "Olympiad Science", "Olympiad Social", "Olympiad Space", "General Knowledge", "Financial Literacy", "Vocab Champ", "Spell Bee"]) {
      expect(within(ecosystem).getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(within(ecosystem).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Explore/i })).toHaveLength(3);
  });

  it("keeps the marquee safe and usable when motion is reduced", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/\.app-marquee-track\s*{\s*animation:\s*none/);
    expect(css).toMatch(/\.app-marquee\s*{\s*overflow-x:\s*auto/);
  });
});
