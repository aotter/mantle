// Deterministic Swolhalla-shaped data: one member (m1) with 3 years of training, plus four noise owners.
// Pure: no Mantle imports. Row objects use the declared field names; lib/prepare.mjs insertRows maps them to columns.
import { mulberry32 } from "../../lib/stats.mjs";

export const SEED_VERSION = 1;
export const NOW = "2026-09-29T00:00:00Z";
const DAY = 86_400_000;
const NOW_MS = Date.parse(NOW);
const T0 = NOW_MS - 1095 * DAY;

export const EXERCISES = [
  ["Back Squat", "quads", "barbell"], ["Front Squat", "quads", "barbell"], ["Leg Press", "quads", "machine"], ["Leg Extension", "quads", "machine"],
  ["Romanian Deadlift", "hamstrings", "barbell"], ["Deadlift", "back", "barbell"], ["Leg Curl", "hamstrings", "machine"], ["Hip Thrust", "glutes", "barbell"],
  ["Bench Press", "chest", "barbell"], ["Incline Bench Press", "chest", "barbell"], ["Dumbbell Press", "chest", "dumbbell"], ["Cable Fly", "chest", "cable"],
  ["Overhead Press", "shoulders", "barbell"], ["Lateral Raise", "shoulders", "dumbbell"], ["Face Pull", "shoulders", "cable"], ["Rear Delt Fly", "shoulders", "dumbbell"],
  ["Barbell Row", "back", "barbell"], ["Pull Up", "back", "bodyweight"], ["Lat Pulldown", "back", "cable"], ["Seated Cable Row", "back", "cable"],
  ["Dumbbell Row", "back", "dumbbell"], ["Barbell Curl", "biceps", "barbell"], ["Hammer Curl", "biceps", "dumbbell"], ["Preacher Curl", "biceps", "machine"],
  ["Triceps Pushdown", "triceps", "cable"], ["Skull Crusher", "triceps", "barbell"], ["Dip", "triceps", "bodyweight"], ["Close Grip Bench Press", "triceps", "barbell"],
  ["Calf Raise", "calves", "machine"], ["Seated Calf Raise", "calves", "machine"], ["Hanging Leg Raise", "abs", "bodyweight"], ["Cable Crunch", "abs", "cable"],
  ["Walking Lunge", "quads", "dumbbell"], ["Bulgarian Split Squat", "quads", "dumbbell"], ["Good Morning", "hamstrings", "barbell"], ["Shrug", "traps", "dumbbell"],
  ["Chest Supported Row", "back", "machine"], ["Pec Deck", "chest", "machine"], ["Arnold Press", "shoulders", "dumbbell"], ["Farmer Carry", "grip", "dumbbell"],
];
const SPLITS = ["legs-a", "push-a", "pull-a", "arms", "legs-b", "push-b", "pull-b", "full"];
const BASE_KG = EXERCISES.map((_, i) => 20 + ((i * 37) % 17) * 7.5);
const round25 = (kg) => Math.round(kg / 2.5) * 2.5;

export const M1_WORKOUTS = 624;
export const M1_SETS = 18_720;
export const NOISE_OWNERS = ["o2", "o3", "o4", "o5"];
export const NOISE_WORKOUTS = 50;
export const NOISE_SETS_PER_OWNER = 1_000;
export const NOISE_SETS = 4_000;

const pad = (n, width) => String(n).padStart(width, "0");

/** Everything the benchmark's items read. */
export const fixture = {
  latestWorkoutId: `w-m1-${pad(M1_WORKOUTS, 4)}`,
  exercise: "Back Squat",
  since: new Date(NOW_MS - 90 * DAY).toISOString(),
};

/** { exercises, workouts, sets }: arrays of declared-name objects. Two calls return deep-equal data. */
export function rows() {
  const rand = mulberry32(20261010);
  const workouts = [];
  const sets = [];
  const addWorkout = (owner, index, startedMs, perBlock, blocks, sessionSets) => {
    const id = `w-${owner}-${pad(index + 1, 4)}`;
    const t = (startedMs - T0) / (NOW_MS - T0);
    const split = index % SPLITS.length;
    workouts.push({
      id, owner, startedAt: new Date(startedMs).toISOString(), splitType: SPLITS[split],
      durationMin: 45 + Math.floor(rand() * 46), sessionRpe: 6 + Math.floor(rand() * 8) / 2, location: rand() < 0.8 ? "home gym" : "commercial gym",
    });
    for (let b = 0; b < blocks; b++) {
      const ex = (split * blocks + b) % EXERCISES.length;
      for (let p = 0; p < perBlock; p++) {
        const warmup = perBlock === 6 && p < 2;
        const working = round25(BASE_KG[ex] * (1 + 0.25 * t) * (warmup ? 0.5 + 0.15 * p : 1));
        sets.push({
          id: `s-${owner}-${pad(sessionSets.next++, 6)}`, owner, workoutId: id, exercise: EXERCISES[ex][0], block: b, position: p,
          weightKg: working, reps: 3 + Math.floor(rand() * 10), rir: Math.floor(rand() * 5), tag: warmup ? "warmup" : "working",
        });
      }
    }
  };
  const m1 = { next: 1 };
  for (let i = 0; i < M1_WORKOUTS; i++) addWorkout("m1", i, Math.round(T0 + i * 1.755 * DAY + rand() * 6 * 3_600_000), 6, 5, m1);
  for (const owner of NOISE_OWNERS) {
    const counter = { next: 1 };
    for (let i = 0; i < NOISE_WORKOUTS; i++) addWorkout(owner, i, Math.round(T0 + i * 21.9 * DAY + rand() * 6 * 3_600_000), 5, 4, counter);
  }
  return { exercises: EXERCISES.map(([name, muscle, equipment], i) => ({ id: `e-${pad(i + 1, 3)}`, name, muscle, equipment })), workouts, sets };
}
