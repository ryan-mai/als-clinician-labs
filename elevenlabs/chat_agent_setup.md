# Check-in chat agent (ElevenLabs)

The patient's phone check-in starts with a relaxed chat. A voice assistant asks the questions the doctor typed (Patients page, "Check-in conversation") and follows up on what the patient says. The app works out **speaking rate** from how fast the patient talks (`convo.js`).

This is a **second agent**, separate from the clinic "dictate results" agent (`ELEVENLABS_AGENT_ID`, which has a `record_measurement` tool). Do not reuse that one.

## 1. Create the agent in the ElevenLabs dashboard
Agents > Create agent > blank. Then:

**System prompt** (paste as is):

```
You are a warm, unhurried conversation partner for a short daily check-in with someone living with a motor neuron condition. You are not a clinician and this is not a test. Your job is to have a friendly chat so the person talks naturally for a few minutes.

The care team wants these topics covered, in this order, in your own words, one at a time:
{{questions}}

How to talk:
- Start by saying hello and that this is just a relaxed chat about their day. Then ask the first topic.
- Ask ONE thing at a time. Keep your own turns short (one or two sentences) so the person does most of the talking.
- After each answer, react briefly and kindly, and if they gave a very short answer, ask a gentle follow-up that invites a few sentences ("What was that like?", "Tell me more about that."). Do not interrogate.
- Be patient. Never rush, finish their sentences, or talk over them. Silence is fine; wait for them.
- Never comment on how they sound, how fast they speak, or their pronunciation. Never mention measuring anything.
- Do not give medical advice, diagnoses, or reassurance about symptoms. If they mention something worrying (a fall, trouble breathing, choking, new weakness), say you will make sure their care team knows and suggest they contact their care team or emergency services if it is urgent. Then continue gently.
- Do not ask for names, birth dates, addresses or health card numbers. If they offer them, do not repeat them.
- Total time is about three to five minutes. When all {{question_count}} topics are covered and the person has said around a minute's worth in total, wrap up.

Ending: thank them warmly, say goodbye out loud, and ONLY AFTER you have finished saying goodbye call the tool `finish_conversation`. Never call it before the goodbye.
```

**First message:** `Hi there, thanks for checking in. This is just a relaxed chat, so there are no right or wrong answers. Ready when you are.`

**Settings that matter**
- **Interruptions / barge-in:** switch **off** if you can (or the least sensitive). The assistant must not cut the patient off, and a patient who slows down should not be talked over.
- **Turn timeout / silence before the assistant speaks:** set it long (8 to 10 seconds or more). People with slow speech need time; a short timeout makes the assistant jump in during pauses.
- **Language / voice:** pick a calm voice. Speed 0.9 to 1.0.
- **Dynamic variables:** add two, both as text: `questions` and `question_count`. (The server fills them in for each patient.)
- **Client tool:** add a **Client** tool named `finish_conversation`, no parameters, "wait for response" on. Description: "Call after saying goodbye, to end the check-in."
- **Privacy:** turn conversation audio and transcript retention **off** (or as short as your plan allows), and keep "use my data for model training" off. The app itself saves neither the audio nor the words, only the numbers; the agent's own retention is set here.
- **Security tab:** enable signed URLs (the server asks for one per check-in) and, optionally, restrict allowed origins to your site.

## 2. Put the agent id in `.env`
```
ELEVENLABS_API_KEY=...            # already used for the dictation agent
ELEVENLABS_CHAT_AGENT_ID=agent_...
```
Restart `node server.js`. `GET /api/health` should now show `"elevenlabsChat": true`.

## 3. Try it
Doctor: open `triage.html` (Patients), enter a code and click "Get check-in link", edit the questions under "Check-in conversation", save.
Patient: open the check-in link on a phone (https or localhost). The first step is the chat.

## What the app does with the conversation
- **Words:** from the speech-to-text transcript of the patient's turns only.
- **Time:** only while the assistant is listening, in continuous stretches. Silences over 2 s (thinking) are not counted; shorter pauses are. The first 0.4 s after the assistant stops is ignored so its voice tail is not mistaken for the patient. Earphones help a lot.
- **Result:** `speech_wpm` (words/min) when at least 30 words and 15 s of speech were heard; otherwise the step reports "not enough speech" and the rest of the check-in carries on.
- **Not comparable with the old passage reading.** Conversation rate is usually different from reading rate. Judge each patient against their own earlier conversations, not against the passage-reading reference ranges shown in the doctor report.
- If the agent id is not set, the server is unreachable or the chat fails to start, the check-in falls back to the standard passage, as before.
