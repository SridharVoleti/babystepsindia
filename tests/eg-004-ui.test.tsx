// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MotivationProgressView } from "@/components/progress/motivation-progress";

describe("EG-004 API-EG-016 exact responsive rendering", () => {
  it("renders ordinal steps and never derives 43% from 3 of 7", () => {
    const { container } = render(<MotivationProgressView progress={{ displayType: "steps",
      stepPosition: 3, stepCount: 7 }} />);
    expect(screen.getByText("Step 3 of 7")).toBeInTheDocument();
    expect(screen.queryByText(/43%/)).not.toBeInTheDocument();
    expect(container.querySelector("progress")).toBeNull();
  });
  it("renders the exact app-supplied percentage with its semantic meter", () => {
    const { container } = render(<MotivationProgressView progress={{ displayType: "percentage",
      percentageValue: 42.5 }} />);
    expect(screen.getAllByText("42.5%")).toHaveLength(2);
    expect(container.querySelector("progress")).toHaveAttribute("value", "42.5");
  });
  it("renders an app label verbatim", () => {
    render(<MotivationProgressView progress={{ displayType: "label", progressLabel: "Building confidence" }} />);
    expect(screen.getByText("Building confidence")).toBeInTheDocument();
  });
  it("renders only the optional message for display type none", () => {
    render(<MotivationProgressView progress={{ displayType: "none", motivationalMessage: "Keep going!" }} />);
    expect(screen.getByText("Keep going!")).toBeInTheDocument();
  });
  it("renders nothing for none without a message", () => {
    const { container } = render(<MotivationProgressView progress={{ displayType: "none" }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("renders current and next step labels without inventing destinations", () => {
    render(<MotivationProgressView progress={{ displayType: "steps", stepPosition: 2, stepCount: 5,
      currentStepLabel: "Fractions", nextStepLabel: "Decimals" }} />);
    expect(screen.getByText("Fractions")).toBeInTheDocument();
    expect(screen.getByText("Next: Decimals")).toBeInTheDocument();
  });
  it("provides a non-color accessible text label for every visible progress form", () => {
    const { rerender } = render(<MotivationProgressView progress={{ displayType: "steps",
      stepPosition: 2, stepCount: 5 }} />);
    expect(screen.getByLabelText("App progress: step 2 of 5")).toBeInTheDocument();
    rerender(<MotivationProgressView progress={{ displayType: "label", progressLabel: "Practising" }} />);
    expect(screen.getByLabelText("App progress: Practising")).toBeInTheDocument();
  });
  it("contains no animation, XP, ranking, reward, or access controls", () => {
    const { container } = render(<MotivationProgressView progress={{ displayType: "percentage",
      percentageValue: 80, motivationalMessage: "Nearly there" }} />);
    expect(container.innerHTML).not.toMatch(/animate|transition|xp|rank|reward|unlock|subscribe/i);
  });
});
