import {
  ASPECT_RATIO_OPTIONS,
  H3_MODEL_OPTIONS,
  RESOLUTION_OPTIONS,
  type AspectRatio,
  type GenerationOptionsValue,
  type H3ModelOption,
  type ResolutionMegapixels,
} from '../shared/generation-options';
import { resolveH3Resolution } from '../shared/resolution';

export type { GenerationOptionsValue } from '../shared/generation-options';

export function GenerationOptions({
  idPrefix,
  value,
  onChange,
  disabled = false,
  showModel = true,
  aspectLabel = '视频比例',
}: {
  idPrefix: string;
  value: GenerationOptionsValue;
  onChange: (value: GenerationOptionsValue) => void;
  disabled?: boolean;
  showModel?: boolean;
  aspectLabel?: string;
}) {
  const aspectField = (
    <div className="field">
      <label htmlFor={`${idPrefix}-aspect`}>{aspectLabel}</label>
      <select
        id={`${idPrefix}-aspect`}
        value={value.aspectRatio}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            ...value,
            aspectRatio: event.target.value as AspectRatio,
          })
        }
      >
        {ASPECT_RATIO_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
  const resolutionField = (
    <div className="field">
      <label htmlFor={`${idPrefix}-resolution`}>分辨率</label>
      <select
        id={`${idPrefix}-resolution`}
        value={String(value.megapixels)}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            ...value,
            megapixels: Number(event.target.value) as ResolutionMegapixels,
          })
        }
      >
        {RESOLUTION_OPTIONS.map((option) => {
          const { width, height } = resolveH3Resolution(
            value.aspectRatio,
            option.value,
          );
          return (
            <option key={option.value} value={String(option.value)}>
              {width} × {height} px
            </option>
          );
        })}
      </select>
    </div>
  );

  if (!showModel) {
    return <div className="form-row image-option-row">{aspectField}{resolutionField}</div>;
  }

  return (
    <>
      <div className="form-row">
        <div className="field">
          <label htmlFor={`${idPrefix}-model`}>H3 模型</label>
          <select
            id={`${idPrefix}-model`}
            value={value.model}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                model: event.target.value as H3ModelOption,
              })
            }
          >
            {H3_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {aspectField}
      </div>
      <div className="form-row">{resolutionField}</div>
    </>
  );
}
