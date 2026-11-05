/**
 * Way — 호스트 중립 "내 방식" 표현 (ADR-020).
 *
 * 새 저장소가 아니다. 기존 저장소(룰·evidence·솔루션·behavior·프로필)를 읽어 만든 뷰다.
 * 호스트 전용 필드(enforce_via, hook 이름 등)는 여기에 없다. 강제 가능 여부만 불리언으로 노출한다.
 */
export type WayKind = 'rule' | 'solution' | 'habit';
export type WayStrength = 'soft' | 'default' | 'strong' | 'hard';

export type Provenance =
  /** 사용자가 한 말. quote 는 발화 원문(있을 때만). */
  | { kind: 'you-said'; quote?: string; date?: string }
  /** 행동 관찰에서 추론. 사용자가 한 말이 아니다. */
  | { kind: 'mined'; date?: string }
  /** 다른 곳(호스트 메모리 파일 등)에서 가져옴. */
  | { kind: 'imported'; from: string; date?: string };

export interface WayItem {
  id: string;
  kind: WayKind;
  statement: string;
  /** 어떤 상황에서 적용되는가. */
  applies_when: string;
  why: string;
  /** 비어 있으면 전역. */
  projects: string[];
  strength: WayStrength;
  provenance: Provenance;
  /** 결정적 탐지기가 있어 강제할 수 있는 룰인가. false 면 자문. */
  enforceable: boolean;
  /** 룰만: 'active' | 'suppressed' | 'removed'. 가져오기에서 고칠 수 있다. */
  status?: 'active' | 'suppressed' | 'removed';
  category?: string;
  /** 렌더러와 같은 예산 우선순위·중복 제거에 쓰는 값 (저장소의 render_key·source·updated_at). */
  render_key?: string;
  source?: 'explicit_correction' | 'onboarding' | 'behavior_inference' | 'pack_overlay' | 'imported';
  updated_at?: string;
  /** 습관만: 이 활성 룰과 상반된다. */
  conflicts_with?: string;
}

export interface WayStats {
  rules_active: number;
  rules_you_said: number;
  rules_mined: number;
  rules_imported: number;
  rules_enforceable: number;
  solutions_verified: number;
  solutions_unverified: number;
  habits: number;
}

export interface Way {
  schema: 'forgen-way/1';
  generator: 'forgen-way';
  generated_at: string;
  items: WayItem[];
  stats: WayStats;
}

export const WAY_SCHEMA = 'forgen-way/1';

export type CompileTarget =
  | 'agents-md' | 'claude-rules' | 'skill' | 'system-prompt' | 'gemini' | 'cursor' | 'workflow' | 'json';
export const COMPILE_TARGETS: CompileTarget[] = ['agents-md', 'claude-rules', 'skill', 'system-prompt', 'gemini', 'cursor', 'workflow', 'json'];

export interface CompiledFile { path: string; content: string }
export interface Omitted { id: string; reason: 'budget' | 'project-scope' | 'not-a-procedure' | 'habit-excluded' | 'not-selected' | 'duplicate' | 'conflict'; detail?: string }
export interface Degraded { id: string; reason: string }
export interface CompileResult { files: CompiledFile[]; omitted: Omitted[]; degraded: Degraded[]; warnings: string[] }
export interface CompileOptions {
  /** 이 프로젝트 키. 없으면 전역 항목만. */
  project?: string;
  /** 본문 글자 수 예산. 넘치면 우선순위로 고르고 나머지는 omitted. */
  budget?: number;
  /** 습관(채굴·프로필)도 포함. 기본 제외. */
  habits?: boolean;
  /** 이 id 만 컴파일 (skill promote 등). */
  only?: string[];
}
