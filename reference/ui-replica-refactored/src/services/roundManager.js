/**
 * RoundManager — tracks AI editing rounds.
 *
 * A round begins when user sends a message, and collects all
 * edit diffs produced by the AI during that response.
 *
 * The diff center displays the CURRENT round by default.
 */
import { store } from './store.js';
import { eventBus } from './eventBus.js';

class RoundManager {
  constructor() {
    this.rounds = [];       // { id, prompt, startTime, files: { filepath: diff } }
    this.currentRoundId = null;
    this._init();
  }

  _init() {
    eventBus.on('chat:send', (prompt) => {
      this.startNewRound(prompt);
    });

    eventBus.on('tool:edit', (diff) => {
      if (diff && diff.file) this.addDiffToCurrentRound(diff.file, diff);
    });

    eventBus.on('chat:response:complete', () => {
      this.finalizeCurrentRound();
    });
  }

  startNewRound(prompt) {
    const round = {
      id: 'round-' + Date.now(),
      prompt: prompt || 'AI 编辑任务',
      startTime: Date.now(),
      endTime: null,
      files: {}
    };
    this.rounds.push(round);
    this.currentRoundId = round.id;
    eventBus.emit('round:start', round);
    return round;
  }

  addDiffToCurrentRound(filepath, diff) {
    const round = this.getCurrentRound();
    if (!round) return;
    round.files[filepath] = diff;
    eventBus.emit('round:diff', { roundId: round.id, filepath, diff });
  }

  finalizeCurrentRound() {
    const round = this.getCurrentRound();
    if (round) {
      round.endTime = Date.now();
      eventBus.emit('round:complete', round);
    }
  }

  getCurrentRound() {
    return this.rounds.find(r => r.id === this.currentRoundId);
  }

  getRound(id) {
    return this.rounds.find(r => r.id === id);
  }

  getAllRounds() {
    return [...this.rounds];
  }

  getRoundSummaries() {
    return this.rounds.map(r => ({
      id: r.id,
      prompt: r.prompt,
      fileCount: Object.keys(r.files).length,
      totalAdded: Object.values(r.files).reduce((s, f) => s + (f.added || 0), 0),
      totalRemoved: Object.values(r.files).reduce((s, f) => s + (f.removed || 0), 0),
      isCurrent: r.id === this.currentRoundId,
      endTime: r.endTime
    }));
  }
}

export const roundManager = new RoundManager();
