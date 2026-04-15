import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";

export type GameWorkflowParams = { gameId: string };

const STEP_RETRIES = {
  retries: { limit: 2, delay: 1000, backoff: "exponential" as const },
};
const DAY_ROUNDS = 2;
const MAX_TURNS = 30;

type DurationStr = `${number} ${"second" | "minute" | "hour"}${"s" | ""}`;

function timeouts(env: Env): {
  night: DurationStr;
  day: DurationStr;
  vote: DurationStr;
} {
  return {
    night: (env.NIGHT_HUMAN_TIMEOUT ?? "2 minute") as DurationStr,
    day: (env.DAY_HUMAN_TIMEOUT ?? "60 second") as DurationStr,
    vote: (env.VOTE_HUMAN_TIMEOUT ?? "2 minute") as DurationStr,
  };
}

export class GameWorkflow extends WorkflowEntrypoint<Env, GameWorkflowParams> {
  async run(event: WorkflowEvent<GameWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { gameId } = event.payload;
    const stub = this.env.GAME_DO.get(this.env.GAME_DO.idFromName(gameId));
    const TIMEOUTS = timeouts(this.env);

    try {
      // Game start announce
      await step.do("game-start", () => stub.setPhase("night", 1, 0));

      for (let turn = 1; turn <= MAX_TURNS; turn++) {
        // ───────────── NIGHT ─────────────
        await step.do(`turn-${turn}-night-start`, () =>
          stub.setPhase("night", turn, 0),
        );

        const livingByRole = await step.do(`turn-${turn}-night-roster`, () =>
          stub.getLivingByRole(),
        );

        // Wolves act (each wolf independently)
        for (const wolf of livingByRole.werewolves) {
          if (wolf.id === livingByRole.humanId) {
            await this.collectHumanNightAction(
              step,
              stub,
              turn,
              wolf.id,
              "kill",
              TIMEOUTS.night,
            );
          } else {
            await step.do(
              `turn-${turn}-wolf-${wolf.id}-ai`,
              STEP_RETRIES,
              () => stub.aiTakeNightAction(wolf.id),
            );
          }
        }

        // Seer
        if (livingByRole.seer) {
          if (livingByRole.seer.id === livingByRole.humanId) {
            await this.collectHumanNightAction(
              step,
              stub,
              turn,
              livingByRole.seer.id,
              "investigate",
              TIMEOUTS.night,
            );
          } else {
            await step.do(
              `turn-${turn}-seer-ai`,
              STEP_RETRIES,
              () => stub.aiTakeNightAction(livingByRole.seer!.id),
            );
          }
        }

        // Doctor
        if (livingByRole.doctor) {
          if (livingByRole.doctor.id === livingByRole.humanId) {
            await this.collectHumanNightAction(
              step,
              stub,
              turn,
              livingByRole.doctor.id,
              "save",
              TIMEOUTS.night,
            );
          } else {
            await step.do(
              `turn-${turn}-doctor-ai`,
              STEP_RETRIES,
              () => stub.aiTakeNightAction(livingByRole.doctor!.id),
            );
          }
        }

        // Resolve night kill+save
        await step.do(`turn-${turn}-night-resolve`, () => stub.resolveNight());

        // Win check
        const winnerAfterNight = await step.do(
          `turn-${turn}-win-check-night`,
          () => stub.currentWinner(),
        );
        if (winnerAfterNight) {
          await step.do(`turn-${turn}-end-game-night`, () =>
            stub.endGame(winnerAfterNight),
          );
          return;
        }

        // Maybe summarize log
        await this.maybeSummarize(step, stub, turn, "after-night");

        // ───────────── DAY DEBATE ─────────────
        for (let round = 1; round <= DAY_ROUNDS; round++) {
          await step.do(`turn-${turn}-day-${round}-start`, () =>
            stub.setPhase("day-debate", turn, round),
          );

          const speakers = await step.do(
            `turn-${turn}-day-${round}-order`,
            () => stub.shuffleSpeakers(`day-${turn}-${round}`),
          );

          for (const playerId of speakers) {
            if (playerId === livingByRole.humanId) continue;
            await step.do(
              `turn-${turn}-day-${round}-${playerId}-speak`,
              STEP_RETRIES,
              () => stub.aiSpeak(playerId, round),
            );
          }

          // Optional: human interject
          if (this.humanIsAlive(livingByRole)) {
            try {
              await step.waitForEvent<{ content?: string }>(
                `turn-${turn}-day-${round}-human-wait`,
                {
                  type: `human-day-${turn}-${round}`,
                  timeout: TIMEOUTS.day,
                },
              );
            } catch {
              // Timeout: human passes
            }
          }
        }

        // ───────────── VOTE ─────────────
        const livingForVote = await step.do(
          `turn-${turn}-vote-roster`,
          () => stub.getLivingByRole(),
        );
        await step.do(`turn-${turn}-vote-start`, () =>
          stub.setPhase("voting", turn, 0),
        );

        for (const player of livingForVote.living) {
          if (player.id === livingForVote.humanId) continue;
          await step.do(
            `turn-${turn}-vote-${player.id}-ai`,
            STEP_RETRIES,
            () => stub.aiVote(player.id),
          );
        }

        // Wait for human vote (timeout = no vote)
        if (this.humanIsAlive(livingForVote)) {
          try {
            await step.waitForEvent<{ target: string }>(
              `turn-${turn}-vote-human-wait`,
              {
                type: `human-vote-${turn}`,
                timeout: TIMEOUTS.vote,
              },
            );
          } catch {
            // Human didn't vote
          }
        }

        await step.do(`turn-${turn}-vote-resolve`, () => stub.resolveVote());

        // Win check after vote
        const winnerAfterVote = await step.do(
          `turn-${turn}-win-check-vote`,
          () => stub.currentWinner(),
        );
        if (winnerAfterVote) {
          await step.do(`turn-${turn}-end-game-vote`, () =>
            stub.endGame(winnerAfterVote),
          );
          return;
        }

        await this.maybeSummarize(step, stub, turn, "after-vote");
      }

      // Hit MAX_TURNS without winner — call it
      await step.do("max-turns-end", () => stub.endGame("error"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await step.do("workflow-fatal-mark-errored", () =>
          stub.markGameErrored(message),
        );
      } catch {
        // Best effort — workflow will still error out
      }
      throw err;
    }
  }

  private humanIsAlive(roster: { humanId: string; living: { id: string }[] }): boolean {
    return roster.living.some((p) => p.id === roster.humanId);
  }

  private async collectHumanNightAction(
    step: WorkflowStep,
    stub: DurableObjectStub<import("./game-do").GameDurableObject>,
    turn: number,
    playerId: string,
    fallbackAction: "kill" | "save" | "investigate",
    timeout: DurationStr,
  ): Promise<void> {
    try {
      const ev = await step.waitForEvent<{ target: string }>(
        `turn-${turn}-night-${playerId}-wait`,
        {
          type: `human-night-${turn}-${playerId}`,
          timeout,
        },
      );
      const target = ev.payload?.target;
      if (target) {
        await step.do(`turn-${turn}-night-${playerId}-record`, () =>
          stub.submitNightAction(playerId, fallbackAction, target),
        );
        return;
      }
    } catch {
      // Timeout — fall through
    }
    await step.do(`turn-${turn}-night-${playerId}-default`, () =>
      stub.submitNightActionRandom(playerId, fallbackAction),
    );
  }

  private async maybeSummarize(
    step: WorkflowStep,
    stub: DurableObjectStub<import("./game-do").GameDurableObject>,
    turn: number,
    suffix: string,
  ): Promise<void> {
    const count = await step.do(`turn-${turn}-log-count-${suffix}`, () =>
      stub.publicLogCount(),
    );
    if (count > 40) {
      await step.do(
        `turn-${turn}-summarize-${suffix}`,
        STEP_RETRIES,
        () => stub.summarizeAndCacheLog(),
      );
    }
  }
}
