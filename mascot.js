'use strict';

/* =====================================================================
   🐶 복구 — WORDLINK 도우미 마스코트
   - 화면 구석에 앉아 있다가 게임 상황에 맞춰 말을 걸어요. (규칙 설명, 응원, 오류 풀이)
   - 복구를 누르면 도움말 메뉴가 열려요. 말 줄이기 · 자리 바꾸기 · 숨기기도 가능해요.
   - client.js 가 window.Bokgu 의 훅(screen · sync · room · rejected · accepted · lowTime)만 불러 줘요.
     복구가 없어도 게임은 그대로 동작하도록, client.js 쪽은 항상 `window.Bokgu?.` 로만 호출합니다.
   - 말풍선 글은 모두 textContent 로 넣어요. (닉네임 등 사용자 입력이 HTML 로 해석되지 않도록)
   ===================================================================== */
(() => {
  if (window.Bokgu) return;

  const PREF_KEY = 'wordlink.bokgu.v1';
  const defaults = { hidden: false, quiet: false, side: 'right', met: false };
  const prefs = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {};
      return {
        hidden: saved.hidden === true,
        quiet: saved.quiet === true,
        side: saved.side === 'left' ? 'left' : 'right',
        met: saved.met === true
      };
    } catch { return { ...defaults }; }
  })();
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 저장소를 못 쓰면 이번 방문에만 적용 */ } }

  // ---------- 도움말 주제 (직접 쓴 고정 문구라 HTML 로 넣어도 안전해요) ----------
  const TOPICS = [
    { icon: '📖', title: '기본 규칙', html: `
      <p>앞 사람이 낸 단어의 <b>끝 글자</b>로 시작하는 단어를 이어 말하는 게임이에요.</p>
      <ul>
        <li>2~12글자 한글 단어만 낼 수 있어요.</li>
        <li>사전에 있는 단어만 인정돼요.</li>
        <li>한 번 나온 단어는 다시 쓸 수 없어요.</li>
        <li>제한 시간 안에 못 내면 그 라운드에서 탈락해요.</li>
      </ul>` },
    { icon: '🔤', title: '두음법칙이 뭐예요?', html: `
      <p>끝 글자가 ‘리·라·녀’ 같은 글자면 <b>소리가 바뀐 글자</b>로 시작해도 돼요. 화면의 ‘다음 글자’ 칸에 쓸 수 있는 글자가 모두 나와요.</p>
      <p class="eg">‘리’ → ‘리’ 또는 ‘이’<br>‘라’ → ‘라’ 또는 ‘나’<br>‘녀’ → ‘녀’ 또는 ‘여’</p>
      <p>예를 들어 <b>구리</b> 다음에는 <b>이불</b>처럼 ‘이’로 시작하는 단어도 낼 수 있어요.</p>` },
    { icon: '⭐', title: '점수는 어떻게 계산돼요?', html: `
      <p>이런 단어일수록 점수가 높아요.</p>
      <ul>
        <li><b>긴 단어</b>일수록</li>
        <li><b>제한 시간이 많이 남았을 때</b> 빨리 낼수록</li>
        <li><b>체인</b>(이번 라운드에 나온 단어 수)이 길수록</li>
        <li><b>미션 글자</b>가 들어갈수록</li>
      </ul>` },
    { icon: '🎯', title: '미션 글자', html: `
      <p>라운드마다 미션 글자가 하나 정해져요. 화면 왼쪽 ‘미션’ 칸에 보여요.</p>
      <ul>
        <li>미션 글자가 들어간 단어를 내면 보너스 점수! (글자 위치는 상관없어요)</li>
        <li>미션 글자가 쓰이면 바로 새 미션 글자로 바뀌어요.</li>
        <li>단어 기록의 🎯×N 은 그 단어에 미션 글자가 N번 들어갔다는 뜻이에요.</li>
      </ul>` },
    { icon: '🏁', title: '라운드와 탈락', html: `
      <ul>
        <li>한 경기는 방장이 고른 3·5·7라운드로 진행돼요.</li>
        <li>라운드가 지날수록 <b>턴 제한 시간이 줄어들어요</b>. (약 13%씩, 최소 5초)</li>
        <li>탈락은 그 라운드에서만! 다음 라운드에는 다시 참가해요.</li>
        <li>가장 많은 라운드를 이긴 사람이 최종 우승이고, 같으면 총점이 높은 사람이 이겨요.</li>
      </ul>` },
    { icon: '💥', title: '한방 단어', html: `
      <p>사전에 <b>이어 갈 단어가 하나도 없는 단어</b>를 한방 단어라고 해요. 상대가 아무것도 못 내서 바로 탈락하게 만들 수 있어요.</p>
      <p>방장이 방을 만들 때나 대기실에서 한방 단어를 <b>허용/금지</b>로 정할 수 있어요. 금지된 방에서 한방 단어를 내면 거부되고, 내 차례와 남은 시간은 그대로예요.</p>` },
    { icon: '🎮', title: '이런 기능도 있어요', html: `
      <ul>
        <li>‘다음 글자’ 칩을 누르면 첫 글자가 자동으로 입력돼요.</li>
        <li>입력하는 동안 첫 글자·중복 같은 규칙을 바로 알려 줘요.</li>
        <li>👍 😂 😮 🔥 👏 😭 반응을 눌러 친구에게 인사할 수 있어요.</li>
        <li>맨 위 ‘효과음’ 버튼으로 소리를 켜고 끌 수 있어요.</li>
        <li>‘초대 링크 복사’로 친구를 방으로 불러요.</li>
      </ul>` },
    { icon: '🐶', title: '복구는 누구예요?', html: `
      <p>저는 끝말잇기 도우미 <b>복구</b>예요! 막힌 단어도, 꼬인 규칙도 ‘복구’해 드릴게요 멍!</p>
      <p>말이 많다 싶으면 아래의 <b>말 줄이기</b>를 눌러 주세요. 그러면 부르실 때만 말하고, 단어가 거부됐을 때 이유만 알려 드려요.</p>` }
  ];

  // ---------- 가끔 건네는 팁 ----------
  const TIPS = {
    home: [
      '닉네임을 정하고 로비에 입장해 보세요. 방 코드나 초대 링크로도 들어갈 수 있어요.'
    ],
    hub: [
      '방 목록에서 카드를 누르면 바로 입장해요. 방 코드를 몰라도 괜찮아요!',
      '‘빠른 입장’을 누르면 자리가 있는 방으로 쏙 데려다줘요.',
      '로비 채팅으로 친구를 불러 보세요. 같이 하면 더 재밌어요 멍!',
      '🔒 표시가 있는 방은 비밀번호가 있어야 들어갈 수 있어요.'
    ],
    lobby: [
      '모두 준비를 누르면 방장이 게임을 시작할 수 있어요.',
      '‘초대 링크 복사’로 친구에게 방을 알려 주세요!',
      '방장은 대기실에서 라운드 수와 제한 시간을 바꿀 수 있어요.'
    ],
    game: [
      '미션 글자가 들어간 단어를 내면 점수가 껑충 뛰어요!',
      '긴 단어, 빠른 입력, 긴 체인일수록 점수가 높아요.',
      '‘다음 글자’ 칩을 누르면 첫 글자가 자동으로 입력돼요.',
      '끝 글자가 ‘리·라·녀’면 두음법칙으로 ‘이·나·여’로 시작해도 돼요.',
      '라운드가 지날수록 제한 시간이 줄어요. 다음 단어를 미리 생각해 둬요!',
      '이모지 반응으로 친구에게 인사해 보세요 👏'
    ]
  };
  const SCREEN_INTRO = {
    hub: '여기는 로비예요. 열린 방을 누르면 바로 입장할 수 있어요!',
    lobby: '대기실이에요. 모두 준비하면 방장이 시작해요. 초대 링크로 친구도 불러 봐요!',
    game: '다음 글자 칩을 누르면 첫 글자가 자동으로 입력돼요. 파이팅 멍!'
  };

  // ---------- 상태 ----------
  const S = {
    screen: '', room: null, me: null,
    lastSpeak: 0, lastActive: Date.now(),
    menuOpen: false, sleeping: false,
    bubbleTimer: 0, moodTimer: 0, hopTimer: 0, outTimer: 0,
    tipCursor: {}, seenScreens: new Set(), errorAt: {}, lowKey: '',
    dueumShown: 0, myTurns: 0, prevFocus: null, introTimer: 0
  };

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.className = 'bokgu';
  root.dataset.mood = 'idle';
  root.innerHTML = `
    <div class="bk-bubble" role="status" aria-live="polite" hidden>
      <span class="bk-name">복구</span>
      <p class="bk-text"></p>
      <div class="bk-actions"></div>
      <button type="button" class="bk-x" aria-label="말풍선 닫기">×</button>
    </div>
    <section class="bk-menu" aria-label="복구 도우미" hidden>
      <div class="bk-menu-head">
        <h2 class="bk-menu-title">복구 도우미 🐾</h2>
        <button type="button" class="bk-menu-close" aria-label="도움말 닫기">×</button>
      </div>
      <div class="bk-menu-body"></div>
      <div class="bk-menu-foot">
        <p class="bk-note" aria-live="polite"></p>
        <button type="button" class="bk-chip" data-act="pet">🐾 쓰다듬기</button>
        <button type="button" class="bk-chip" data-act="quiet" aria-pressed="false">🤫 말 줄이기</button>
        <button type="button" class="bk-chip" data-act="side">↔ 자리 바꾸기</button>
        <button type="button" class="bk-chip" data-act="hide">숨기기</button>
      </div>
    </section>
    <button type="button" class="bk-dog" aria-label="복구에게 도움 받기" aria-expanded="false" title="복구에게 물어보기">
      ${dogSvg()}
    </button>`;
  const callButton = document.createElement('button');
  callButton.type = 'button';
  callButton.className = 'bk-call';
  callButton.setAttribute('aria-label', '복구 불러오기');
  callButton.title = '복구 불러오기';
  callButton.textContent = '🐾';

  const $ = selector => root.querySelector(selector);
  const bubble = $('.bk-bubble');
  const bubbleText = $('.bk-text');
  const bubbleActions = $('.bk-actions');
  const menu = $('.bk-menu');
  const menuBody = $('.bk-menu-body');
  const note = $('.bk-note');
  const dogButton = $('.bk-dog');

  function dogSvg() {
    const ink = '#6b4423';
    return `<svg class="bk-svg" viewBox="0 0 120 132" aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="127" rx="31" ry="4.5" fill="rgba(40,80,20,.28)"/>
      <g class="bk-tail">
        <path d="M84 106 C100 106 108 92 102 78" fill="none" stroke="${ink}" stroke-width="13" stroke-linecap="round"/>
        <path d="M84 106 C100 106 108 92 102 78" fill="none" stroke="#e9a85a" stroke-width="8.5" stroke-linecap="round"/>
      </g>
      <path d="M34 112 C32 92 42 82 60 82 C78 82 88 92 86 112 C86 120 78 124 60 124 C42 124 34 120 34 112Z" fill="#f6c987" stroke="${ink}" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M47 100 C47 92 53 89 60 89 C67 89 73 92 73 100 C73 112 68 120 60 120 C52 120 47 112 47 100Z" fill="#fff1d6"/>
      <ellipse cx="48" cy="121" rx="9" ry="5.5" fill="#fff1d6" stroke="${ink}" stroke-width="2.2"/>
      <ellipse cx="72" cy="121" rx="9" ry="5.5" fill="#fff1d6" stroke="${ink}" stroke-width="2.2"/>
      <path d="M45.5 119.6v3M50.5 119.6v3M69.5 119.6v3M74.5 119.6v3" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M41 88 Q60 100 79 88" fill="none" stroke="${ink}" stroke-width="9" stroke-linecap="round"/>
      <path d="M41 88 Q60 100 79 88" fill="none" stroke="#e8532b" stroke-width="5.6" stroke-linecap="round"/>
      <circle cx="60" cy="98" r="6.2" fill="#ffd45c" stroke="${ink}" stroke-width="1.8"/>
      <text x="60" y="100.7" text-anchor="middle" font-size="7.6" font-weight="700" fill="${ink}" font-family="Jua,'Noto Sans KR',sans-serif">복</text>
      <g class="bk-head">
        <g class="bk-ear-l"><path d="M34 38 C20 35 11 52 15 68 C18 79 30 79 36 68 C41 60 41 46 39 40Z" fill="#c9873f" stroke="${ink}" stroke-width="2.4" stroke-linejoin="round"/></g>
        <g class="bk-ear-r"><path d="M86 38 C100 35 109 52 105 68 C102 79 90 79 84 68 C79 60 79 46 81 40Z" fill="#c9873f" stroke="${ink}" stroke-width="2.4" stroke-linejoin="round"/></g>
        <ellipse cx="60" cy="58" rx="35" ry="31" fill="#f6c987" stroke="${ink}" stroke-width="2.4"/>
        <ellipse cx="60" cy="70" rx="19" ry="14.5" fill="#fff1d6"/>
        <g class="brow-idle"><ellipse cx="46" cy="45" rx="3.8" ry="2.6" fill="#c9873f"/><ellipse cx="74" cy="45" rx="3.8" ry="2.6" fill="#c9873f"/></g>
        <g class="brow-worry"><path d="M41 46 L51 43" stroke="#8a5a2b" stroke-width="2.4" stroke-linecap="round"/><path d="M79 46 L69 43" stroke="#8a5a2b" stroke-width="2.4" stroke-linecap="round"/></g>
        <g class="e-open bk-eyes-open">
          <ellipse cx="46" cy="56" rx="4.4" ry="5.4" fill="#3b2410"/><circle cx="47.7" cy="53.8" r="1.7" fill="#fff"/>
          <ellipse cx="74" cy="56" rx="4.4" ry="5.4" fill="#3b2410"/><circle cx="75.7" cy="53.8" r="1.7" fill="#fff"/>
        </g>
        <g class="e-happy"><path d="M41 58 Q46 50 51 58" fill="none" stroke="#3b2410" stroke-width="2.6" stroke-linecap="round"/><path d="M69 58 Q74 50 79 58" fill="none" stroke="#3b2410" stroke-width="2.6" stroke-linecap="round"/></g>
        <g class="e-sleep"><path d="M41 56 Q46 61 51 56" fill="none" stroke="#3b2410" stroke-width="2.4" stroke-linecap="round"/><path d="M69 56 Q74 61 79 56" fill="none" stroke="#3b2410" stroke-width="2.4" stroke-linecap="round"/></g>
        <ellipse cx="36" cy="67" rx="5" ry="3.2" fill="#f59a8c" opacity=".55"/>
        <ellipse cx="84" cy="67" rx="5" ry="3.2" fill="#f59a8c" opacity=".55"/>
        <path d="M53.5 63.5 Q60 59 66.5 63.5 Q64.5 70 60 70 Q55.5 70 53.5 63.5Z" fill="#3b2410"/>
        <ellipse cx="57.5" cy="62.8" rx="2" ry="1" fill="#fff" opacity=".6"/>
        <path class="m-idle" d="M60 70 V73.5 M60 73.5 Q56 78 51.5 75.2 M60 73.5 Q64 78 68.5 75.2" fill="none" stroke="#3b2410" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <g class="m-happy"><path d="M51 74 Q60 90 69 74 Q60 71 51 74Z" fill="#7a2f2f" stroke="#3b2410" stroke-width="2" stroke-linejoin="round"/><ellipse cx="60" cy="79" rx="4.6" ry="3" fill="#ff8fa3"/></g>
        <path class="m-worry" d="M60 70 V73 M52.5 79.5 Q60 73 67.5 79.5" fill="none" stroke="#3b2410" stroke-width="2" stroke-linecap="round"/>
        <ellipse class="m-o" cx="60" cy="77.5" rx="3.2" ry="4" fill="#7a2f2f" stroke="#3b2410" stroke-width="1.8"/>
        <path class="x-sweat" d="M91 44 Q95 51 91 54 Q87 51 91 44Z" fill="#8fd3ff" stroke="#3b82f6" stroke-width="1.2"/>
      </g>
      <g class="x-zzz" fill="#3b2a14" font-family="Jua,'Noto Sans KR',sans-serif" font-weight="700">
        <text x="92" y="30" font-size="14">z</text><text x="100" y="18" font-size="10">z</text>
      </g>
      <g class="x-spark" fill="#ffd45c" stroke="#e8761a" stroke-width="1" stroke-linejoin="round">
        <path d="M14 26 l2.6 6 6 2.6 -6 2.6 -2.6 6 -2.6 -6 -6 -2.6 6 -2.6z"/>
        <path d="M104 14 l2 4.6 4.6 2 -4.6 2 -2 4.6 -2 -4.6 -4.6 -2 4.6 -2z"/>
      </g>
    </svg>`;
  }

  // ---------- 표정 · 말풍선 ----------
  function setMood(mood, ms = 0) {
    clearTimeout(S.moodTimer);
    if (mood !== 'sleep') S.sleeping = false;
    root.dataset.mood = mood;
    if (ms > 0) S.moodTimer = setTimeout(() => setMood('idle'), ms);
  }
  function hop() {
    root.classList.remove('hop');
    void root.offsetWidth; // 애니메이션을 처음부터 다시 재생
    root.classList.add('hop');
    clearTimeout(S.hopTimer);
    S.hopTimer = setTimeout(() => root.classList.remove('hop'), 500);
  }
  function hideBubble() {
    clearTimeout(S.bubbleTimer);
    if (bubble.hidden) return;
    bubble.classList.remove('in');
    bubble.classList.add('out');
    clearTimeout(S.outTimer);
    S.outTimer = setTimeout(() => { bubble.hidden = true; bubble.classList.remove('out'); }, 170);
    if (root.dataset.mood !== 'sleep') setMood('idle');
  }
  function armBubbleTimer(ms) {
    clearTimeout(S.bubbleTimer);
    S.bubbleTimer = setTimeout(hideBubble, ms);
  }

  // kind: user(직접 누름) · help(오류 풀이) · alert(시간 경고) · cheer(응원) · tip(팁)
  function canSpeak(kind) {
    if (prefs.hidden) return false;
    if (kind === 'user') return true;
    if (S.menuOpen || document.hidden) return false;
    if (prefs.quiet && kind !== 'help') return false;
    const gap = Date.now() - S.lastSpeak;
    if (kind === 'tip' && gap < 20000) return false;
    if (kind === 'cheer' && gap < 2500) return false;
    return true;
  }
  function say(text, o = {}) {
    const kind = o.kind || 'tip';
    if (!text || !canSpeak(kind)) return false;
    clearTimeout(S.outTimer);
    bubbleText.textContent = text;
    bubbleActions.textContent = '';
    for (const action of o.actions || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `bk-chip${action.primary ? ' primary' : ''}`;
      chip.textContent = action.label;
      chip.addEventListener('click', () => { hideBubble(); action.run?.(); });
      bubbleActions.appendChild(chip);
    }
    bubble.hidden = false;
    bubble.classList.remove('in', 'out');
    void bubble.offsetWidth;
    bubble.classList.add('in');
    const ms = o.ms ?? Math.min(9000, Math.max(3800, 2600 + text.length * 95));
    setMood(o.mood || 'happy', Math.min(ms, 6000));
    hop();
    if (!o.sticky) armBubbleTimer(o.actions?.length ? ms + 3000 : ms);
    S.lastSpeak = S.lastActive = Date.now();
    return true;
  }
  bubble.addEventListener('mouseenter', () => clearTimeout(S.bubbleTimer));
  bubble.addEventListener('mouseleave', () => { if (!bubble.hidden) armBubbleTimer(2200); });
  bubble.addEventListener('focusin', () => clearTimeout(S.bubbleTimer));
  bubble.addEventListener('focusout', () => { if (!bubble.hidden) armBubbleTimer(2200); });
  $('.bk-x').addEventListener('click', hideBubble);

  // ---------- 도움말 메뉴 ----------
  function showTopics() {
    menuBody.textContent = '';
    const hello = document.createElement('p');
    hello.className = 'bk-hello';
    hello.textContent = '무엇이 궁금해요?';
    menuBody.appendChild(hello);
    TOPICS.forEach((topic, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bk-topic';
      const icon = document.createElement('span');
      icon.className = 'ic';
      icon.textContent = topic.icon;
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon, document.createTextNode(topic.title));
      button.addEventListener('click', () => showTopic(index));
      menuBody.appendChild(button);
    });
    menuBody.scrollTop = 0;
  }
  function showTopic(index) {
    const topic = TOPICS[index];
    menuBody.textContent = '';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'bk-back';
    back.textContent = '← 목록으로';
    back.addEventListener('click', () => { showTopics(); menuBody.querySelector('.bk-topic')?.focus(); });
    const detail = document.createElement('div');
    detail.className = 'bk-detail';
    const heading = document.createElement('h3');
    heading.textContent = `${topic.icon} ${topic.title}`;
    detail.appendChild(heading);
    detail.insertAdjacentHTML('beforeend', topic.html);
    menuBody.append(back, detail);
    menuBody.scrollTop = 0;
    back.focus();
    setMood('think', 1800);
  }
  function syncControls() {
    root.hidden = prefs.hidden;
    callButton.hidden = !prefs.hidden;
    root.classList.toggle('left', prefs.side === 'left');
    callButton.classList.toggle('left', prefs.side === 'left');
    const quiet = $('[data-act="quiet"]');
    quiet.setAttribute('aria-pressed', String(prefs.quiet));
    quiet.textContent = prefs.quiet ? '🤫 말 줄이는 중' : '🤫 말 줄이기';
  }
  function openMenu() {
    hideBubble();
    S.prevFocus = document.activeElement;
    S.menuOpen = true;
    S.lastActive = Date.now();
    menu.hidden = false;
    root.dataset.open = 'true';
    dogButton.setAttribute('aria-expanded', 'true');
    note.textContent = '';
    showTopics();
    setMood('think', 1800);
    menuBody.querySelector('.bk-topic')?.focus({ preventScroll: true });
  }
  function closeMenu({ restoreFocus = true } = {}) {
    if (!S.menuOpen) return;
    S.menuOpen = false;
    menu.hidden = true;
    root.dataset.open = 'false';
    dogButton.setAttribute('aria-expanded', 'false');
    setMood('idle');
    if (restoreFocus) {
      const target = S.prevFocus && S.prevFocus.isConnected && S.prevFocus !== document.body ? S.prevFocus : dogButton;
      target.focus({ preventScroll: true });
    }
    S.prevFocus = null;
  }
  const PET_LINES = ['헤헤, 좋아요!', '꼬리가 저절로 움직여요 멍!', '더 쓰다듬어 주세요~', '오늘도 끝말잇기 파이팅!'];
  let petCount = 0;
  dogButton.addEventListener('click', () => { S.lastActive = Date.now(); S.menuOpen ? closeMenu() : openMenu(); });
  $('.bk-menu-close').addEventListener('click', () => closeMenu());
  $('.bk-menu-foot').addEventListener('click', event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'pet') {
      note.textContent = PET_LINES[petCount++ % PET_LINES.length];
      setMood('cheer', 1700);
    } else if (act === 'quiet') {
      prefs.quiet = !prefs.quiet;
      savePrefs(); syncControls();
      note.textContent = prefs.quiet ? '알겠어요! 부르실 때만 말할게요.' : '다시 도와드릴게요 멍!';
    } else if (act === 'side') {
      prefs.side = prefs.side === 'left' ? 'right' : 'left';
      savePrefs(); syncControls();
      note.textContent = '자리를 옮겼어요!';
    } else if (act === 'hide') {
      closeMenu({ restoreFocus: false });
      prefs.hidden = true;
      savePrefs(); syncControls();
      callButton.focus({ preventScroll: true });
    }
  });
  callButton.addEventListener('click', () => {
    prefs.hidden = false;
    savePrefs(); syncControls();
    say('다시 불러 주셔서 고마워요! 필요하면 저를 눌러 주세요 멍!', { kind: 'user', mood: 'cheer' });
    dogButton.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && S.menuOpen) { event.stopPropagation(); closeMenu(); }
  }, true);
  document.addEventListener('pointerdown', event => {
    if (S.menuOpen && !root.contains(event.target)) closeMenu({ restoreFocus: false });
  });

  // ---------- 게임 상황별 반응 ----------
  const pick = list => list[Math.floor(Math.random() * list.length)];
  function nextTip(pool) {
    const list = TIPS[pool];
    if (!list || !list.length) return '';
    S.tipCursor[pool] = ((S.tipCursor[pool] ?? Math.floor(Math.random() * list.length)) + 1) % list.length;
    return list[S.tipCursor[pool]];
  }
  const labelOf = letters => letters.map(item => `‘${item}’`).join(' 또는 ');

  // 단어가 거부된 이유를 풀어 준다. 인라인 안내와 겹치지 않도록 같은 이유는 12초에 한 번만.
  function explain(code, allowed) {
    const now = Date.now();
    if (now - (S.errorAt[code] || 0) < 12000) return;
    let text = '';
    if (code === 'UNKNOWN') {
      text = pick([
        '사전에 없는 단어래요. 사전에는 기본형 단어 위주로 들어 있어서, 활용형이나 너무 전문적인 말은 없을 수 있어요.',
        '앗, 이 단어는 사전에서 못 찾았어요. 받침을 확인하거나 비슷한 다른 단어를 떠올려 봐요!'
      ]);
    } else if (code === 'ONESHOT') {
      text = '이 방은 한방 단어가 금지예요. 이어 갈 단어가 없는 단어는 낼 수 없어요. 차례는 그대로니까 다른 단어를 골라 봐요!';
    } else if (code === 'DUPLICATE') {
      text = '그 단어는 이미 나왔어요. 오른쪽 단어 기록에서 확인해 보세요!';
    } else if (code === 'CHAIN' || code === 'START') {
      text = allowed.length > 1
        ? `${labelOf(allowed)}(으)로 시작해야 해요. 두음법칙 덕분에 두 글자 모두 쓸 수 있어요!`
        : allowed.length === 1 ? `${labelOf(allowed)}(으)로 시작하는 단어를 찾아볼까요?` : '';
    }
    if (!text) return;
    S.errorAt[code] = now;
    say(text, { kind: 'help', mood: 'worry', ms: 6500 });
  }

  const Bokgu = {
    // client.js 의 화면 전환 (home · hub · lobby · game)
    screen(key) {
      S.screen = key;
      clearTimeout(S.introTimer);
      if (key === 'home' && !prefs.met) {
        S.introTimer = setTimeout(() => {
          if (S.screen !== 'home') return;
          const shown = say('안녕하세요! 저는 끝말잇기 도우미 복구예요 🐶 궁금한 게 있으면 저를 눌러 주세요!', {
            kind: 'user', mood: 'cheer', ms: 9000,
            actions: [{ label: '도움말 보기', primary: true, run: openMenu }, { label: '괜찮아요' }]
          });
          if (shown) { prefs.met = true; savePrefs(); }
        }, 1100);
        return;
      }
      if (!SCREEN_INTRO[key] || S.seenScreens.has(key)) return;
      S.seenScreens.add(key);
      S.introTimer = setTimeout(() => { if (S.screen === key) say(SCREEN_INTRO[key], { kind: 'tip', mood: 'happy' }); }, 1500);
    },

    // 화면을 그릴 때마다 최신 방 정보를 받아 둔다. (상황 판단용)
    sync(room, me) { S.room = room || null; S.me = me || null; },

    // room:update 로 방이 바뀔 때 이전/다음 스냅샷을 비교해 반응한다.
    room(prev, next, me) {
      if (!prev || !next || prev.code !== next.code || !me) return;
      const mine = next.players.find(player => player.id === me);
      const before = prev.players.find(player => player.id === me);

      if (prev.state === 'lobby' && next.state === 'playing') {
        say(`게임 시작! ${next.totalRounds}라운드 승부예요. 첫 단어는 자유롭게, 길수록 점수가 높아요!`, { kind: 'cheer', mood: 'cheer' });
        S.myTurns = 0;
        return;
      }
      if (prev.state === 'playing' && next.state === 'finished') {
        const won = next.winnerId === me;
        say(won ? '우승이에요!! 정말 대단해요 멍멍! 🏆' : '수고했어요! 다음 판에는 꼭 이겨 봐요. 결과 요약도 확인해 보세요!', { kind: 'cheer', mood: won ? 'cheer' : 'happy', ms: 6500 });
        return;
      }
      if (prev.state === 'playing' && next.state === 'intermission') {
        const result = next.roundResult;
        if (result && result.winnerId === me) say(`ROUND ${result.round} 승리! 멋져요! 🎉`, { kind: 'cheer', mood: 'cheer' });
        else if (result && !result.winnerId) say('무승부! 팽팽한 승부였어요.', { kind: 'cheer', mood: 'happy' });
        else say('다음 라운드에서 만회해요! 파이팅!', { kind: 'cheer', mood: 'happy' });
        return;
      }
      if (prev.state === 'intermission' && next.state === 'playing') {
        const seconds = next.turnDurationMs ? Math.round(next.turnDurationMs / 1000) : next.turnSeconds;
        say(`ROUND ${next.round} 시작! 이번 턴 제한 시간은 ${seconds}초예요.`, { kind: 'cheer', mood: 'alert', ms: 4200 });
        return;
      }
      if (next.state !== 'playing') return;

      if (mine && before && !before.eliminated && mine.eliminated) {
        say(next.round < next.totalRounds ? '아쉽지만 괜찮아요! 탈락은 이번 라운드뿐이에요. 다음 라운드에 다시 도전해요!' : '아깝다…! 그래도 잘했어요 멍.', { kind: 'cheer', mood: 'sad', ms: 5500 });
        return;
      }
      const myTurnNow = next.currentPlayerId === me && !(mine && mine.eliminated);
      const turnStarted = myTurnNow && (prev.currentPlayerId !== me || prev.state !== 'playing');
      if (!turnStarted) return;
      S.myTurns += 1;
      const allowed = next.allowedSyllables || [];
      if (allowed.length > 1 && (S.dueumShown < 3 || Math.random() < 0.3)) {
        S.dueumShown += 1;
        say(`내 차례예요! ${labelOf(allowed)}(으)로 시작하면 돼요. (두음법칙)`, { kind: 'cheer', mood: 'think', ms: 3800 });
      } else if (!next.lastSyllable && S.myTurns <= 2) {
        say('내 차례예요! 첫 단어는 아무 글자로 시작해도 돼요.', { kind: 'cheer', mood: 'think', ms: 3800 });
      }
    },

    // 단어가 거부됐을 때 (code: 서버 코드 또는 클라이언트 검사 코드)
    rejected(info = {}) {
      S.lastActive = Date.now();
      const allowed = (S.room && S.room.allowedSyllables) || [];
      explain(info.code, allowed);
    },

    // 단어가 받아들여졌을 때
    accepted(info = {}) {
      S.lastActive = Date.now();
      const length = [...String(info.word || '')].length;
      if (info.missions) say(`🎯 미션 글자 성공! 보너스 점수 +${info.points}점이에요. 멋져요 멍!`, { kind: 'cheer', mood: 'cheer' });
      else if (info.chain >= 5 && info.chain % 5 === 0) say(`${info.chain}체인! 이 흐름 정말 좋아요!`, { kind: 'cheer', mood: 'cheer' });
      else if (length >= 6) say(`${length}글자 단어라니, 대단해요! 점수가 쑥 올랐어요.`, { kind: 'cheer', mood: 'happy' });
      else if (Math.random() < 0.25) say(pick(['좋아요!', '잘했어요!', '이 기세로 쭉 가요!']), { kind: 'cheer', mood: 'happy', ms: 2400 });
    },

    // 내 차례에 시간이 얼마 안 남았을 때 (턴마다 한 번)
    lowTime(turnKey, seconds) {
      if (S.lowKey === turnKey) return;
      S.lowKey = turnKey;
      say(`${seconds}초 남았어요! 서둘러요!`, { kind: 'alert', mood: 'alert', ms: 2400 });
    }
  };
  window.Bokgu = Bokgu;

  // ---------- 가끔 건네는 팁 · 졸기 ----------
  setInterval(() => {
    if (prefs.hidden || document.hidden || S.menuOpen) return;
    const now = Date.now();
    const room = S.room;
    const myTurn = Boolean(room && room.state === 'playing' && room.currentPlayerId === S.me);
    const quiet = now - S.lastActive > 150000 && bubble.hidden;
    if (quiet && !myTurn && !S.sleeping && root.dataset.mood === 'idle') { S.sleeping = true; setMood('sleep'); }
    if (prefs.quiet || myTurn || now - S.lastSpeak < 55000 || now - S.lastActive < 8000) return;
    let pool = S.screen;
    if (pool === 'game') {
      if (!room || room.state !== 'playing') return;
    } else if (!TIPS[pool]) return;
    say(nextTip(pool), { kind: 'tip', mood: 'happy' });
  }, 5000);

  // ---------- 붙이기 ----------
  function mount() {
    document.body.append(root, callButton);
    syncControls();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
