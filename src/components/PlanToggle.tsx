export function PlanToggle({
  checked,
  onChange,
  disabled = false,
  compact = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Plan mode"
      className={`plan-toggle ${checked ? "plan-toggle-on" : ""} ${compact ? "plan-toggle-compact" : ""}`}
      title={
        checked
          ? "Plan mode is on: the agent proposes a plan before changing anything"
          : "Plan mode is off: the agent works directly"
      }
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="plan-toggle-track" aria-hidden="true">
        <span className="plan-toggle-thumb" />
      </span>
      <span className="plan-toggle-label">Plan mode</span>
    </button>
  );
}
