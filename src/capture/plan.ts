import type { CaptionSourcePreference, CapturePlan, CapturePlanItem, LocalAsrEngineId, LocalAsrEngineView } from "../core/schema";

export interface CapturePlanConfig {
  captionSource?: CaptionSourcePreference;
  systemCaptionsHelper?: string;
  systemCaptionsHelperArgs?: string[];
  localAsrEngineId?: LocalAsrEngineId;
  localAsrEngines?: LocalAsrEngineView[];
}

const ORDER: Array<{ kind: CaptionSourcePreference; label: string }> = [
  { kind: "local-asr", label: "本地识别" },
  { kind: "system-captions", label: "Windows 系统字幕" }
];

export function buildCapturePlan(config: CapturePlanConfig): CapturePlan {
  const preference = config.captionSource ?? "local-asr";
  const localAsrEngineId = config.localAsrEngineId ?? "moonshine-tiny-en";
  const localAsrEngines = config.localAsrEngines ?? [];
  const selectedEngine = localAsrEngines.find((engine) => engine.engineId === localAsrEngineId);
  const items: CapturePlanItem[] = ORDER.map((item, index) => {
    const available =
      item.kind === "system-captions"
        ? Boolean(config.systemCaptionsHelper?.trim())
        : selectedEngine?.available === true;
    return {
      kind: item.kind,
      label: item.label,
      priority: index + 1,
      available,
      reason: available
        ? undefined
        : item.kind === "local-asr"
          ? selectedEngine?.reason ?? `未发现本地识别引擎 ${localAsrEngineId}`
          : `${item.label} 未配置`
    };
  });

  const preferred = items.find((item) => item.kind === preference);
  const primary = preferred?.available ? preferred.kind : undefined;
  const mode =
    primary === "system-captions"
      ? "offline-lite"
      : primary === "local-asr"
        ? "offline-enhanced"
        : "unavailable";

  return { preference, localAsrEngineId, localAsrEngines, mode, items, primary };
}
