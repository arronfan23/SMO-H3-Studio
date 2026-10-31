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
}: {
  idPrefix: string;
  value: GenerationOptionsValue;
  onChange: (value: GenerationOptionsValue) => void;
  disabled?: boolean;
}) {
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
        <div className="field">
          <label htmlFor={`${idPrefix}-aspect`}>视频比例</label>
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
      </div>
      <div className="form-row">
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
        <div className="field">
          <label htmlFor={`${idPrefix}-subtitles`}>生成画面内字幕</label>
          <label className="checkbox-field">
            <input
              id={`${idPrefix}-subtitles`}
              type="checkbox"
              checked={value.subtitles}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, subtitles: event.target.checked })
              }
            />
            <span>在画面安全区内显示字幕</span>
          </label>
        </div>
      </div>
    </>
  );
}
