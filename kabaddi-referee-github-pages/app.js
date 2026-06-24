const MAIN_PRESET_MS = [20 * 60 * 1000, 15 * 60 * 1000];
const INITIAL_MAIN_MS = MAIN_PRESET_MS[0];
const INITIAL_RAID_MS = 30 * 1000;
const MAX_MAIN_MS = 99 * 60 * 1000 + 59 * 1000;
const MAX_RAID_MS = 99 * 1000;
const TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUTS_PER_HALF = 2;
const RAID_WARNING_START_SECONDS = 10;
const PLAYER_COUNT = 7;
const PLAYER_BOARD_VERSION = 2;
const STORAGE_KEY = "kabaddi-referee-state-v1";

const state = {
  half: "first",
  displaySwapped: false,
  outSequence: 0,
  teams: [
    { id: "teamA", name: "チームA", score: 0, raidCount: 0, players: createPlayerStates(), timeouts: createTimeoutCounts(), theme: "blue" },
    { id: "teamB", name: "チームB", score: 0, raidCount: 0, players: createPlayerStates(), timeouts: createTimeoutCounts(), theme: "red" },
  ],
  timers: {
    main: createTimer(INITIAL_MAIN_MS),
    raid: createTimer(INITIAL_RAID_MS),
  },
  timeout: createTimeoutState(),
};

const dom = {
  app: document.querySelector("[data-app]"),
  panels: Array.from(document.querySelectorAll("[data-team-panel]")),
  halfButtons: Array.from(document.querySelectorAll("[data-half]")),
  swap: document.querySelector("[data-swap]"),
  mainTime: document.querySelector("[data-main-time]"),
  raidTime: document.querySelector("[data-raid-time]"),
  mainDurationLabel: document.querySelector("[data-main-duration-label]"),
  mainPresetButtons: Array.from(document.querySelectorAll("[data-main-preset-ms]")),
  timerAdjustButtons: Array.from(document.querySelectorAll("[data-timer-adjust]")),
  mainToggle: document.querySelector("[data-main-toggle]"),
  raidToggle: document.querySelector("[data-raid-toggle]"),
  mainReset: document.querySelector("[data-main-reset]"),
  raidReset: document.querySelector("[data-raid-reset]"),
  resetScores: document.querySelector("[data-reset-scores]"),
  resetMatch: document.querySelector("[data-reset-match]"),
  buzzer: document.querySelector("[data-buzzer]"),
  bonus: document.querySelector("[data-bonus]"),
  raidOut: document.querySelector("[data-raid-out]"),
  timeoutOverlay: document.querySelector("[data-timeout-overlay]"),
  timeoutCountdown: document.querySelector("[data-timeout-countdown]"),
  timeoutTeam: document.querySelector("[data-timeout-team]"),
  timeoutHalf: document.querySelector("[data-timeout-half]"),
  timeoutNumber: document.querySelector("[data-timeout-number]"),
};

let audioContext = null;
let heldBuzzer = null;
let timeoutIntervalId = null;
let speechVoicesReady = null;
const speechVoiceCache = { male: undefined, female: undefined };

loadState();
bindEvents();
prepareSpeechVoices();
render();
registerServiceWorker();

function createTimer(initialMs) {
  return {
    initialMs,
    remainingMs: initialMs,
    running: false,
    intervalId: null,
    endAt: 0,
    lastWarningSecond: null,
    finishSignaled: false,
  };
}

function bindEvents() {
  dom.panels.forEach((panel) => {
    panel.addEventListener("click", (event) => {
      const team = getTeamById(panel.dataset.teamId);
      if (!team) return;

      if (event.target.closest("[data-timeout-request]")) {
        requestTeamTimeout(team);
        return;
      }

      if (event.target.closest("[data-all-in]")) {
        setTeamPlayersIn(team);
        return;
      }

      const playerInButton = event.target.closest("[data-player-in]");
      if (playerInButton) {
        setPlayerOut(team, Number(playerInButton.dataset.playerIn), false);
        return;
      }

      const playerOutButton = event.target.closest("[data-player-out]");
      if (playerOutButton) {
        setPlayerOut(team, Number(playerOutButton.dataset.playerOut), true);
        return;
      }

      const scoreButton = event.target.closest("[data-score-delta]");
      if (scoreButton) {
        team.score = Math.max(0, team.score + Number(scoreButton.dataset.scoreDelta));
        persistState();
        renderTeams();
        return;
      }

      if (event.target.closest("[data-raid-advance]")) {
        advanceRaid(team);
        return;
      }

      if (event.target.closest("[data-raid-count-reset]")) {
        resetRaid(team);
      }
    });

    panel.addEventListener("input", (event) => {
      const team = getTeamById(panel.dataset.teamId);
      if (!team) return;

      const playerNumberInput = event.target.closest("[data-player-number]");
      if (playerNumberInput) {
        const playerNumber = normalizePlayerNumber(playerNumberInput.value);
        playerNumberInput.value = playerNumber;
        setPlayerNumber(team, Number(playerNumberInput.dataset.playerNumber), playerNumber);
        renderPlayers(panel, team);
        return;
      }

      if (!event.target.matches("[data-team-name]")) return;
      team.name = event.target.value;
      persistState();
    });
  });

  dom.halfButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setHalf(button.dataset.half);
    });
  });

  dom.swap.addEventListener("click", () => {
    setHalf(state.displaySwapped ? "first" : "second");
  });

  dom.mainToggle.addEventListener("click", () => toggleTimer("main"));
  dom.raidToggle.addEventListener("click", () => toggleTimer("raid"));
  dom.mainReset.addEventListener("click", () => resetTimer("main"));
  dom.raidReset.addEventListener("click", () => resetTimer("raid"));

  dom.mainPresetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setMainDuration(Number(button.dataset.mainPresetMs));
    });
  });

  dom.timerAdjustButtons.forEach((button) => {
    button.addEventListener("click", () => {
      adjustTimer(button.dataset.timerAdjust, Number(button.dataset.adjustMs));
    });
  });

  if (dom.buzzer) {
    dom.buzzer.addEventListener("pointerdown", startManualBuzzer);
    dom.buzzer.addEventListener("pointerup", stopManualBuzzer);
    dom.buzzer.addEventListener("pointercancel", stopManualBuzzer);
    dom.buzzer.addEventListener("pointerleave", stopManualBuzzer);
    dom.buzzer.addEventListener("lostpointercapture", stopManualBuzzer);
    dom.buzzer.addEventListener("keydown", (event) => {
      if (!isBuzzerKey(event) || event.repeat) return;
      startManualBuzzer(event);
    });
    dom.buzzer.addEventListener("keyup", (event) => {
      if (!isBuzzerKey(event)) return;
      stopManualBuzzer(event);
    });
    dom.buzzer.addEventListener("blur", stopManualBuzzer);
  }

  if (dom.bonus) {
    dom.bonus.addEventListener("click", playBonusPointVoice);
  }

  if (dom.raidOut) {
    dom.raidOut.addEventListener("click", playRaidOutVoice);
  }

  dom.resetScores.addEventListener("click", () => {
    state.teams.forEach((team) => {
      team.score = 0;
    });
    persistState();
    renderTeams();
  });

  dom.resetMatch.addEventListener("click", () => {
    pauseTimer("main");
    pauseTimer("raid");
    state.half = "first";
    state.displaySwapped = false;
    state.teams[0].name = "チームA";
    state.teams[0].score = 0;
    state.teams[0].raidCount = 0;
    state.teams[0].players = createPlayerStates();
    state.teams[0].timeouts = createTimeoutCounts();
    state.teams[1].name = "チームB";
    state.teams[1].score = 0;
    state.teams[1].raidCount = 0;
    state.teams[1].players = createPlayerStates();
    state.teams[1].timeouts = createTimeoutCounts();
    state.outSequence = 0;
    state.timeout = createTimeoutState();
    clearTimeoutCountdown();
    state.timers.main.initialMs = INITIAL_MAIN_MS;
    state.timers.main.remainingMs = INITIAL_MAIN_MS;
    state.timers.raid.remainingMs = INITIAL_RAID_MS;
    resetRaidTimerSignals();
    persistState();
    render();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tickTimers();
      tickTimeout();
    }
  });
}

function isBuzzerKey(event) {
  return event.key === " " || event.key === "Enter";
}

function startManualBuzzer(event) {
  event.preventDefault();
  if (event.pointerId !== undefined && dom.buzzer.setPointerCapture) {
    try {
      dom.buzzer.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture can fail if the pointer is no longer active.
    }
  }
  startHeldBuzzer();
  dom.buzzer.classList.add("is-active");
}

function stopManualBuzzer(event) {
  event.preventDefault();
  stopHeldBuzzer();
  dom.buzzer.classList.remove("is-active");
}

function createPlayerStates() {
  return Array.from({ length: PLAYER_COUNT }, () => createPlayerState());
}

function createPlayerState() {
  return { number: "", out: false, outOrder: 0 };
}

function createTimeoutCounts() {
  return { first: 0, second: 0 };
}

function createTimeoutState() {
  return {
    active: false,
    teamId: "",
    teamName: "",
    teamTheme: "",
    half: "first",
    count: 0,
    remainingMs: 0,
    endAt: 0,
  };
}

function setPlayerOut(team, playerIndex, isOut) {
  const player = ensurePlayerState(team, playerIndex);
  if (!player) return;
  if (isOut) {
    player.out = true;
    if (!player.outOrder) {
      state.outSequence += 1;
      player.outOrder = state.outSequence;
    }
  } else {
    player.out = false;
    player.outOrder = 0;
  }
  persistState();
  renderTeams();
}

function setTeamPlayersIn(team) {
  team.players.forEach((player) => {
    player.out = false;
    player.outOrder = 0;
  });
  state.outSequence = getMaxOutOrder();
  persistState();
  renderTeams();
}

function setPlayerNumber(team, playerIndex, playerNumber) {
  const player = ensurePlayerState(team, playerIndex);
  if (!player) return;
  player.number = normalizePlayerNumber(playerNumber);
  persistState();
}

function advanceRaid(team) {
  const previousRaidCount = team.raidCount;
  team.raidCount = previousRaidCount >= 3 ? 1 : previousRaidCount + 1;
  persistState();
  renderTeams();

  if (previousRaidCount < 3 && team.raidCount === 3) {
    playBuzzer();
  }
}

function resetRaid(team) {
  team.raidCount = 0;
  persistState();
  renderTeams();
}

function requestTeamTimeout(team) {
  team.timeouts = normalizeTimeoutCounts(team.timeouts);
  const currentCount = getTimeoutCount(team, state.half);
  if (state.timeout.active || currentCount >= MAX_TIMEOUTS_PER_HALF) return;

  const nextCount = currentCount + 1;
  pauseTimer("main");
  pauseTimer("raid");
  team.timeouts[state.half] = nextCount;
  state.timeout = {
    active: true,
    teamId: team.id,
    teamName: team.name,
    teamTheme: team.theme,
    half: state.half,
    count: nextCount,
    remainingMs: TIMEOUT_MS,
    endAt: Date.now() + TIMEOUT_MS,
  };
  persistState();
  renderTeams();
  renderTimers();
  renderTimeoutOverlay();
  startTimeoutCountdown();
}

function startTimeoutCountdown() {
  clearTimeoutCountdown();
  timeoutIntervalId = window.setInterval(tickTimeout, 100);
  tickTimeout();
}

function clearTimeoutCountdown() {
  if (!timeoutIntervalId) return;
  clearInterval(timeoutIntervalId);
  timeoutIntervalId = null;
}

function tickTimeout() {
  if (!state.timeout.active) {
    clearTimeoutCountdown();
    return;
  }

  state.timeout.remainingMs = Math.max(0, state.timeout.endAt - Date.now());
  renderTimeoutOverlay();
  if (state.timeout.remainingMs > 0) return;

  playRaidEndBuzzer();
  state.timeout = createTimeoutState();
  clearTimeoutCountdown();
  renderTimeoutOverlay();
  renderTeams();
  renderTimers();
}

function setHalf(half) {
  state.half = half === "second" ? "second" : "first";
  state.displaySwapped = state.half === "second";
  persistState();
  render();
}

function toggleTimer(timerName) {
  const timer = state.timers[timerName];
  if (timer.running) {
    pauseTimer(timerName);
  } else {
    startTimer(timerName);
  }
  renderTimers();
}

function startTimer(timerName) {
  if (state.timeout.active) return;
  const timer = state.timers[timerName];
  if (timer.remainingMs <= 0) {
    timer.remainingMs = timer.initialMs;
  }
  if (timerName === "raid" && timer.remainingMs > RAID_WARNING_START_SECONDS * 1000) {
    resetRaidTimerSignals();
  }
  if (timerName === "raid") {
    getAudioContext();
  }
  timer.running = true;
  timer.endAt = Date.now() + timer.remainingMs;
  clearInterval(timer.intervalId);
  timer.intervalId = window.setInterval(tickTimers, 100);
  tickTimers();
}

function pauseTimer(timerName) {
  const timer = state.timers[timerName];
  if (!timer.running) return;
  timer.remainingMs = Math.max(0, timer.endAt - Date.now());
  timer.running = false;
  clearInterval(timer.intervalId);
  timer.intervalId = null;
  persistState();
}

function resetTimer(timerName) {
  pauseTimer(timerName);
  const timer = state.timers[timerName];
  timer.remainingMs = timer.initialMs;
  if (timerName === "raid") {
    resetRaidTimerSignals();
  }
  persistState();
  renderTimers();
}

function setMainDuration(durationMs) {
  if (!MAIN_PRESET_MS.includes(durationMs)) return;
  pauseTimer("main");
  state.timers.main.initialMs = durationMs;
  state.timers.main.remainingMs = durationMs;
  persistState();
  renderTimers();
}

function adjustTimer(timerName, deltaMs) {
  const timer = state.timers[timerName];
  if (!timer || !Number.isFinite(deltaMs)) return;

  if (timer.running) {
    timer.remainingMs = Math.max(0, timer.endAt - Date.now());
  }

  const maxMs = timerName === "main" ? MAX_MAIN_MS : MAX_RAID_MS;
  timer.remainingMs = clamp(roundToDisplayedSecond(timer.remainingMs) + deltaMs, 0, maxMs);

  if (timer.running) {
    timer.endAt = Date.now() + timer.remainingMs;
  }

  if (timerName === "raid" && timer.running && timer.remainingMs === 0) {
    timer.finishSignaled = false;
    signalRaidTimer(timer);
  } else if (timerName === "raid") {
    updateRaidTimerSignalMemory(timer);
  }

  persistState();
  renderTimers();
}

function tickTimers() {
  let changed = false;
  Object.keys(state.timers).forEach((timerName) => {
    const timer = state.timers[timerName];
    if (!timer.running) return;
    timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    if (timerName === "raid") {
      signalRaidTimer(timer);
    }
    if (timer.remainingMs === 0) {
      timer.running = false;
      clearInterval(timer.intervalId);
      timer.intervalId = null;
      changed = true;
    }
  });
  renderTimers();
  if (changed) persistState();
}

function signalRaidTimer(timer) {
  const seconds = Math.ceil(timer.remainingMs / 1000);

  if (seconds > RAID_WARNING_START_SECONDS) {
    timer.lastWarningSecond = null;
    timer.finishSignaled = false;
    return;
  }

  if (seconds > 0 && timer.lastWarningSecond !== seconds) {
    timer.lastWarningSecond = seconds;
    playShortBeep();
    return;
  }

  if (seconds === 0 && !timer.finishSignaled) {
    timer.finishSignaled = true;
    playRaidEndBuzzer();
  }
}

function updateRaidTimerSignalMemory(timer) {
  const seconds = Math.ceil(timer.remainingMs / 1000);

  if (seconds > RAID_WARNING_START_SECONDS) {
    timer.lastWarningSecond = null;
    timer.finishSignaled = false;
    return;
  }

  if (seconds > 0) {
    timer.lastWarningSecond = null;
    timer.finishSignaled = false;
    return;
  }

  timer.lastWarningSecond = null;
  timer.finishSignaled = true;
}

function resetRaidTimerSignals() {
  state.timers.raid.lastWarningSecond = null;
  state.timers.raid.finishSignaled = false;
}

function render() {
  renderTeams();
  renderHalves();
  renderTimers();
  renderTimeoutOverlay();
}

function renderTeams() {
  const orderedTeams = state.displaySwapped ? [state.teams[1], state.teams[0]] : state.teams;

  orderedTeams.forEach((team, index) => {
    const panel = dom.panels[index];
    const input = panel.querySelector("[data-team-name]");
    const score = panel.querySelector("[data-score]");

    panel.dataset.teamId = team.id;
    panel.dataset.theme = team.theme;
    if (document.activeElement !== input) {
      input.value = team.name;
    }
    score.value = team.score;
    score.textContent = String(team.score);
    renderPlayers(panel, team);
    renderRaidLights(panel, team.raidCount);
    renderTimeoutControls(panel, team);
  });
}

function renderPlayers(panel, team) {
  const rows = Array.from(panel.querySelectorAll("[data-player-slot]"))
    .map((slot) => {
      const playerIndex = Number(slot.dataset.playerSlot);
      return { slot, playerIndex, player: ensurePlayerState(team, playerIndex) };
    })
    .filter((row) => row.player);

  const outPlayers = rows
    .filter((row) => row.player.out)
    .sort((a, b) => a.player.outOrder - b.player.outOrder || a.playerIndex - b.playerIndex);
  const availablePlayers = rows
    .filter((row) => !row.player.out)
    .sort(comparePlayersByNumber);

  outPlayers.forEach((row, order) => {
    renderPlayerSlot(row, order, "out");
  });

  availablePlayers.forEach((row, order) => {
    renderPlayerSlot(row, order, "in");
  });
}

function renderPlayerSlot(row, order, status) {
  const { slot, playerIndex, player } = row;
  const isOut = Boolean(player.out);
  const numberInput = slot.querySelector("[data-player-number]");
  const inButton = slot.querySelector("[data-player-in]");
  const outButton = slot.querySelector("[data-player-out]");

  slot.style.order = String(order);
  slot.style.gridColumn = status === "out" ? "2" : "1";
  slot.style.gridRow = String(order + 1);
  slot.classList.toggle("is-out", isOut);
  slot.classList.toggle("is-available", !isOut);
  slot.setAttribute("aria-label", `選手${playerIndex + 1} ${player.number || "番号未入力"} ${isOut ? "OUT" : "IN"}`);
  if (numberInput && document.activeElement !== numberInput) {
    numberInput.value = player.number;
  }
  if (inButton) {
    inButton.classList.toggle("is-active", isOut);
    inButton.setAttribute("aria-pressed", String(isOut));
    inButton.disabled = !isOut;
  }
  if (outButton) {
    outButton.classList.toggle("is-active", !isOut);
    outButton.setAttribute("aria-pressed", String(!isOut));
    outButton.disabled = isOut;
  }
}

function comparePlayersByNumber(a, b) {
  const aNumber = Number(a.player.number);
  const bNumber = Number(b.player.number);
  const aHasNumber = a.player.number !== "" && Number.isFinite(aNumber);
  const bHasNumber = b.player.number !== "" && Number.isFinite(bNumber);

  if (aHasNumber && bHasNumber && aNumber !== bNumber) return aNumber - bNumber;
  if (aHasNumber !== bHasNumber) return aHasNumber ? -1 : 1;
  return a.playerIndex - b.playerIndex;
}

function renderRaidLights(panel, raidCount) {
  panel.querySelectorAll("[data-raid-light]").forEach((light) => {
    const lightNumber = Number(light.dataset.raidLight);
    light.classList.toggle("is-on", lightNumber <= raidCount);
    light.setAttribute("aria-hidden", "true");
  });

  const lights = panel.querySelector("[data-raid-lights]");
  lights.setAttribute("aria-label", `RAID ${raidCount}/3`);
}

function renderTimeoutControls(panel, team) {
  const button = panel.querySelector("[data-timeout-request]");
  const countLabel = panel.querySelector("[data-timeout-count]");
  if (!button || !countLabel) return;

  const count = getTimeoutCount(team, state.half);
  const usedUp = count >= MAX_TIMEOUTS_PER_HALF;
  const isActiveTeam = state.timeout.active && state.timeout.teamId === team.id;

  button.disabled = state.timeout.active || usedUp;
  button.classList.toggle("is-active", isActiveTeam);
  button.classList.toggle("is-used-up", usedUp);
  button.setAttribute("aria-pressed", String(isActiveTeam));
  countLabel.textContent = `${count}/${MAX_TIMEOUTS_PER_HALF}`;
}

function renderTimeoutOverlay() {
  if (!dom.timeoutOverlay) return;
  if (!state.timeout.active) {
    dom.timeoutOverlay.hidden = true;
    dom.timeoutOverlay.removeAttribute("data-theme");
    return;
  }

  dom.timeoutOverlay.hidden = false;
  dom.timeoutOverlay.dataset.theme = state.timeout.teamTheme;
  dom.timeoutCountdown.textContent = String(Math.ceil(state.timeout.remainingMs / 1000));
  dom.timeoutTeam.textContent = state.timeout.teamName;
  dom.timeoutHalf.textContent = state.timeout.half === "second" ? "後半" : "前半";
  dom.timeoutNumber.textContent = `${state.timeout.count}回目 / ${MAX_TIMEOUTS_PER_HALF}`;
}

function renderHalves() {
  dom.halfButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.half === state.half);
    button.setAttribute("aria-pressed", String(button.dataset.half === state.half));
  });
}

function renderTimers() {
  dom.mainTime.value = formatMainTime(state.timers.main.remainingMs);
  dom.mainTime.textContent = formatMainTime(state.timers.main.remainingMs);
  dom.raidTime.value = formatRaidTime(state.timers.raid.remainingMs);
  dom.raidTime.textContent = formatRaidTime(state.timers.raid.remainingMs);
  dom.mainDurationLabel.textContent = formatDurationLabel(state.timers.main.initialMs);
  dom.mainPresetButtons.forEach((button) => {
    const durationMs = Number(button.dataset.mainPresetMs);
    button.classList.toggle("is-active", durationMs === state.timers.main.initialMs);
    button.setAttribute("aria-pressed", String(durationMs === state.timers.main.initialMs));
  });
  renderTimerButton(dom.mainToggle, state.timers.main, "メインタイマー");
  renderTimerButton(dom.raidToggle, state.timers.raid, "30秒タイマー");
}

function renderTimerButton(button, timer, label) {
  button.textContent = timer.running ? "⏸" : "▶";
  button.title = timer.running ? "停止" : "開始";
  button.setAttribute("aria-label", `${label}${timer.running ? "停止" : "開始"}`);
  button.classList.toggle("is-running", timer.running);
  button.disabled = state.timeout.active;
}

function formatMainTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatRaidTime(ms) {
  return String(Math.ceil(ms / 1000)).padStart(2, "0");
}

function formatDurationLabel(ms) {
  return `${Math.round(ms / 60000)}分`;
}

function roundToDisplayedSecond(ms) {
  return Math.ceil(ms / 1000) * 1000;
}

function getTeamById(teamId) {
  return state.teams.find((team) => team.id === teamId);
}

function getAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;

  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  return audioContext;
}

function playShortBeep() {
  const context = getAudioContext();
  if (!context) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  const duration = 0.08;

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(1240, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function playRaidEndBuzzer() {
  playLongBuzzer({
    baseFrequency: 700,
    overtoneFrequency: 1400,
    volume: 0.28,
    duration: 2,
  });
}

function playBuzzer() {
  playLongBuzzer({
    baseFrequency: 520,
    overtoneFrequency: 1040,
    volume: 0.24,
    duration: 2,
  });
}

function startHeldBuzzer() {
  if (heldBuzzer) return;
  const context = getAudioContext();
  if (!context) return;

  const oscillator = context.createOscillator();
  const overtone = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;

  oscillator.type = "triangle";
  overtone.type = "sawtooth";
  oscillator.frequency.setValueAtTime(330, now);
  overtone.frequency.setValueAtTime(495, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.26, now + 0.04);
  oscillator.connect(gain);
  overtone.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  overtone.start(now);
  oscillator.addEventListener("ended", () => {
    oscillator.disconnect();
    overtone.disconnect();
    gain.disconnect();
  });
  heldBuzzer = { oscillator, overtone, gain };
}

function stopHeldBuzzer() {
  if (!heldBuzzer || !audioContext) return;
  const { oscillator, overtone, gain } = heldBuzzer;
  const now = audioContext.currentTime;
  heldBuzzer = null;

  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.001), now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
  oscillator.stop(now + 0.1);
  overtone.stop(now + 0.1);
}

function playBonusPointVoice() {
  playVoiceAnnouncement({
    text: "ボーナスポイント！",
    gender: "male",
    rate: 1.12,
    pitch: 0.78,
  });
}

function playRaidOutVoice() {
  playVoiceAnnouncement({
    text: "レイドアウト",
    gender: "female",
    rate: 1.04,
    pitch: 1.18,
  });
}

async function playVoiceAnnouncement({ text, gender, rate, pitch }) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    playRaidEndBuzzer();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = rate;
  utterance.pitch = pitch;
  utterance.volume = 1;

  const voice = await getCachedJapaneseVoice(gender);
  if (voice) {
    utterance.voice = voice;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function prepareSpeechVoices() {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  if (speechVoicesReady) return speechVoicesReady;

  speechVoicesReady = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    window.setTimeout(finish, 900);
  });
  return speechVoicesReady;
}

async function getCachedJapaneseVoice(gender) {
  if (speechVoiceCache[gender] !== undefined) return speechVoiceCache[gender];
  const voices = await prepareSpeechVoices();
  speechVoiceCache[gender] = findJapaneseVoice(voices, gender);
  return speechVoiceCache[gender];
}

function findJapaneseVoice(voices, gender) {
  const japaneseVoices = voices.filter((voice) => voice.lang && voice.lang.toLowerCase().startsWith("ja"));
  const malePattern = /male|男性|男|otoya|ichiro|daichi|keita|takumi|akira|kazu|osamu|shinji/i;
  const femalePattern = /female|女性|女|kyoko|haruka|nanami|ayumi|ichiko|sayaka|sakura|yui|mizuki|naoko/i;
  const targetPattern = gender === "female" ? femalePattern : malePattern;
  const otherPattern = gender === "female" ? malePattern : femalePattern;
  return (
    japaneseVoices.find((voice) => targetPattern.test(voice.name)) ||
    japaneseVoices.find((voice) => !otherPattern.test(voice.name)) ||
    japaneseVoices[0] ||
    null
  );
}

function playLongBuzzer({ baseFrequency, overtoneFrequency, volume, duration }) {
  const context = getAudioContext();
  if (!context) return;

  const oscillator = context.createOscillator();
  const overtone = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;

  oscillator.type = "sawtooth";
  overtone.type = "square";
  oscillator.frequency.setValueAtTime(baseFrequency, now);
  overtone.frequency.setValueAtTime(overtoneFrequency, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.04);
  gain.gain.setValueAtTime(volume, now + duration - 0.12);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  oscillator.connect(gain);
  overtone.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  overtone.start(now);
  oscillator.stop(now + duration);
  overtone.stop(now + duration);
}

function persistState() {
  const snapshot = {
    half: state.half,
    displaySwapped: state.displaySwapped,
    outSequence: state.outSequence,
    playerBoardVersion: PLAYER_BOARD_VERSION,
    teams: state.teams.map((team) => ({ ...team })),
    timers: {
      main: {
        initialMs: state.timers.main.initialMs,
        remainingMs: state.timers.main.remainingMs,
      },
      raid: { remainingMs: state.timers.raid.remainingMs },
    },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const saved = JSON.parse(raw);
    let shouldPersistLoadedState = false;
    if (saved.half === "second") {
      state.half = "second";
      state.displaySwapped = true;
    }
    state.outSequence = Number.isFinite(saved.outSequence) ? Math.max(0, saved.outSequence) : 0;
    if (Array.isArray(saved.teams) && saved.teams.length === 2) {
      saved.teams.forEach((savedTeam, index) => {
        state.teams[index].name = typeof savedTeam.name === "string" ? savedTeam.name : state.teams[index].name;
        state.teams[index].score = Number.isFinite(savedTeam.score) ? Math.max(0, savedTeam.score) : state.teams[index].score;
        state.teams[index].raidCount = Number.isFinite(savedTeam.raidCount) ? clamp(savedTeam.raidCount, 0, 3) : state.teams[index].raidCount;
        state.teams[index].players = normalizePlayerStates(savedTeam.players);
        state.teams[index].timeouts = normalizeTimeoutCounts(savedTeam.timeouts);
      });
      state.outSequence = Math.max(state.outSequence, getMaxOutOrder());
      if (saved.playerBoardVersion !== PLAYER_BOARD_VERSION) {
        resetAllPlayersIn();
        shouldPersistLoadedState = true;
      }
    }
    if (MAIN_PRESET_MS.includes(saved.timers?.main?.initialMs)) {
      state.timers.main.initialMs = saved.timers.main.initialMs;
    }
    if (Number.isFinite(saved.timers?.main?.remainingMs)) {
      state.timers.main.remainingMs = clamp(saved.timers.main.remainingMs, 0, MAX_MAIN_MS);
    }
    if (Number.isFinite(saved.timers?.raid?.remainingMs)) {
      state.timers.raid.remainingMs = clamp(saved.timers.raid.remainingMs, 0, MAX_RAID_MS);
    }
    if (shouldPersistLoadedState) {
      persistState();
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function normalizePlayerStates(players) {
  if (!Array.isArray(players)) return createPlayerStates();
  return Array.from({ length: PLAYER_COUNT }, (_, index) => normalizePlayerState(players[index]));
}

function normalizePlayerState(player) {
  if (typeof player === "boolean") {
    return { number: "", out: player, outOrder: player ? getNextOutOrder() : 0 };
  }

  if (!player || typeof player !== "object") {
    return createPlayerState();
  }

  const isOut = Boolean(player.out);
  const savedOutOrder = Number.isFinite(player.outOrder) ? Math.max(0, player.outOrder) : 0;

  return {
    number: normalizePlayerNumber(player.number),
    out: isOut,
    outOrder: isOut ? savedOutOrder || getNextOutOrder() : 0,
  };
}

function normalizeTimeoutCounts(timeouts) {
  if (!timeouts || typeof timeouts !== "object") return createTimeoutCounts();
  return {
    first: clampTimeoutCount(timeouts.first),
    second: clampTimeoutCount(timeouts.second),
  };
}

function clampTimeoutCount(value) {
  return Number.isFinite(value) ? clamp(Math.floor(value), 0, MAX_TIMEOUTS_PER_HALF) : 0;
}

function getTimeoutCount(team, half) {
  team.timeouts = normalizeTimeoutCounts(team.timeouts);
  return team.timeouts[half] || 0;
}

function ensurePlayerState(team, playerIndex) {
  if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= PLAYER_COUNT) return null;
  if (!Array.isArray(team.players)) {
    team.players = createPlayerStates();
  }
  team.players[playerIndex] = normalizePlayerState(team.players[playerIndex]);
  return team.players[playerIndex];
}

function normalizePlayerNumber(value) {
  return typeof value === "string" ? value.replace(/\D/g, "").slice(0, 3) : "";
}

function resetAllPlayersIn() {
  state.outSequence = 0;
  state.teams.forEach((team) => {
    team.players.forEach((player) => {
      player.out = false;
      player.outOrder = 0;
    });
  });
}

function getNextOutOrder() {
  state.outSequence += 1;
  return state.outSequence;
}

function getMaxOutOrder() {
  return state.teams.reduce((maxOrder, team) => {
    const teamMax = team.players.reduce((maxPlayerOrder, player) => Math.max(maxPlayerOrder, player.outOrder || 0), 0);
    return Math.max(maxOrder, teamMax);
  }, 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!["http:", "https:"].includes(window.location.protocol)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // The app still works normally if offline caching is unavailable.
    });
  });
}
