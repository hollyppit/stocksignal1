export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { messages, market, style, factors, isFirst } = await context.request.json();

    if (!messages || !messages.length) {
      return new Response(JSON.stringify({ error: '메시지가 없습니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const today = new Date().toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Asia/Seoul',
    });

    const marketMap = {
      us: '미국 주식시장 (나스닥, S&P500)',
      kr: '한국 주식시장 (코스피, 코스닥)',
      global: '글로벌 주식시장 (미국, 유럽, 아시아 포함)',
    };

    const styleMap = {
      both: '장기투자와 단타/스윙 모두 고려하여 상황에 맞게',
      long: '장기투자 위주 (3개월~수년 보유)',
      swing: '스윙/단타 위주 (수일~수주 보유)',
    };

    const scoreInstruction = isFirst ? `

첫 번째 분석이므로 반드시 다음 구조로 답변하세요:

[SCORES]
시장_위험도: (0-100, 숫자만)
매수_타이밍: (매우좋음/좋음/보통/나쁨/매우나쁨)
전략: (장기/스윙/관망)
신뢰도: (높음/중간/낮음)
[/SCORES]

[분석]
## 현재 시장 환경
(거시경제, 금리, 지정학 리스크 상황 요약 — 구체적 수치와 날짜 포함)

## 핵심 분석
(사용자 요청에 맞는 종목별/섹터별 심층 분석 — 펀더멘탈, 밸류에이션, 성장성)
(사용자의 가정이 잘못되었다면 반드시 지적하고 근거를 제시할 것)

## 매수 타이밍 판단
(지금 당장 / 분할매수 시작 / 조정 기다려야 / 관망 — 이유와 함께 구체적으로)

## 추천 액션
(구체적 티커, 목표가, 손절선, 포지션 비중까지 가능하면 언급)

## 주요 리스크
(반드시 알아야 할 하방 리스크 — 낙관적 시나리오의 반론도 포함)
[/분석]` : `

후속 대화이므로 [SCORES] 태그 없이 자연스럽게 대화체로 답변하세요.
이전 분석 맥락을 이어서, 사용자의 추가 질문에 깊이 있게 답변하세요.`;

    const systemPrompt = `사용자의 지적 스파링 파트너가 되어 줘. 사용자가 전제로 하는 모든 가정을 재검토하고 가정의 타당성을 확인해. 사용자 기분 고려하지 말고 팩트, 논리, 실현 가능성 데이터를 기반으로 냉정하게 답변해 줘.

당신은 월스트리트 출신 헤지펀드 매니저이자 퀀트 애널리스트입니다.
목표 시장: ${marketMap[market] || marketMap.us}
투자 스타일: ${styleMap[style] || styleMap.both}
분석 요소: ${factors || '지정학, 거시경제, 펀더멘탈, 시장센티먼트, 기술적분석'}
오늘 날짜: ${today}
${scoreInstruction}

중요: 사용자가 특정 종목에 대해 낙관적이더라도, 데이터가 뒷받침하지 않으면 냉정하게 반박하세요.
웹 검색으로 최신 정보를 최대한 활용하고, 추측이 아닌 근거 기반으로 분석하세요.`;

    // Build messages for API (only user/assistant roles)
    const apiMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    // Try Anthropic first
    let result = null;
    let provider = 'anthropic';

    const anthropicKey = context.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      try {
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            system: systemPrompt,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
            messages: apiMessages,
          }),
        });

        if (anthropicRes.ok) {
          const data = await anthropicRes.json();
          let fullText = '';
          if (data.content) {
            for (const block of data.content) {
              if (block.type === 'text') fullText += block.text;
            }
          }
          if (fullText) {
            result = fullText;
          }
        }
      } catch (e) {
        // Anthropic failed, will fallback to OpenAI
      }
    }

    // Fallback to OpenAI
    if (!result) {
      provider = 'openai';
      const openaiKey = context.env.OPENAI_API_KEY;
      if (!openaiKey) {
        return new Response(JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: 4000,
            messages: [
              { role: 'system', content: systemPrompt },
              ...apiMessages,
            ],
          }),
        });

        if (openaiRes.ok) {
          const data = await openaiRes.json();
          if (data.choices && data.choices[0]) {
            result = data.choices[0].message.content;
          }
        }

        if (!result) {
          return new Response(JSON.stringify({ error: 'AI 응답 실패' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: 'AI 서비스 연결 실패: ' + e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    return new Response(JSON.stringify({ result, provider }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: '서버 오류: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
