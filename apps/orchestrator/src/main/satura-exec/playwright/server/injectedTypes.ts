export type ElementState = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'editable' | 'checked' | 'unchecked' | 'indeterminate' | 'stable';
export type ElementStateWithoutStable = Exclude<ElementState, 'stable'>;
export type HitTargetInterceptionResult = {
  stop: () => 'done' | { hitTargetDescription: string };
};
export type InjectedScript = any;
