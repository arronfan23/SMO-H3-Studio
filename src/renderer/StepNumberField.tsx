import { Minus, Plus } from 'lucide-react';

export function StepNumberField({
  id,
  label,
  value,
  recommended,
  min,
  max,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  recommended: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const hintId = `${id}-hint`;

  return (
    <div className="field step-number-field">
      <label htmlFor={id}>{label}</label>
      <div className="step-number-control">
        <button
          className="button button-secondary step-number-button"
          type="button"
          aria-label="减少步数"
          disabled={disabled || !Number.isFinite(value) || value <= min}
          onClick={() => onChange(value - 1)}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <input
          id={id}
          className="step-number-input"
          type="number"
          min={min}
          max={max}
          step={1}
          value={Number.isNaN(value) ? '' : value}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
        <button
          className="button button-secondary step-number-button"
          type="button"
          aria-label="增加步数"
          disabled={disabled || !Number.isFinite(value) || value >= max}
          onClick={() => onChange(value + 1)}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <p id={hintId} className="skill-description step-number-hint" aria-live="polite">
        {value > recommended ? '高于推荐值会增加耗时' : null}
      </p>
    </div>
  );
}
