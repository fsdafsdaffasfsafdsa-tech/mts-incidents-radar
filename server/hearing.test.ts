// Слух Джарвиса на живых фразах: ему или нет, эхо или ответ, перебили или шум.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS } from '../shared/personas.ts';
import { SLEEP_RE, afterWake, bargeIn, forMeWithoutName, isCommand, isEcho, isQuestionForMe, looksForMe, sameRequest, wakeRe } from '../shared/hearing.ts';
import { quickWall } from './jarvis.ts';

const WAKE = wakeRe(PERSONAS[0].wake);
const ASKED = 'Сэр, новый инцидент на распределение — «жалобы: МТС Банк · Самарская область». ИИ советует «Радиосеть · Москва». Передать?';

test('имя: в начале, в середине, с падежом и как его слышит распознавание', () => {
  for (const t of ['Джарвис, что горит', 'слушай джарвис покажи почту', 'жарвис открой входящие', 'джарвиз сколько жалоб', 'Джарвису передай', 'jarvis что горит'])
    assert.ok(WAKE.test(t), t);
  for (const t of ['давай посмотрим', 'Ярвис на обед пошёл?', 'харизма']) assert.ok(!WAKE.test(t), t);
  assert.equal(afterWake('Джарвис, что горит', WAKE), 'что горит');
  assert.equal(afterWake('слушай, джарвис, покажи почту', WAKE), 'покажи почту');
});

test('без имени: просьба или вопрос о деле — ему; разговор людей — нет', () => {
  const yes = [
    'привет разберись с мтс банком',
    'покажи почту',
    'так открой входящие',
    'а что у нас по мтс банку',
    'что сейчас горит',
    'сколько жалоб в москве',
    'какие инциденты критические',
    'кому передать этот инцидент',
    'проверь сроки',
    'ну расскажи что с командой',
  ];
  const no = ['лучше чем было но всё равно', 'что будем есть на обед', 'как дела', 'я сейчас подойду', 'ну да наверное', 'кто последний в очереди за кофе?'.replace('очереди', 'ряду')];
  for (const t of yes) assert.ok(forMeWithoutName(t), `ему: ${t}`);
  for (const t of no) assert.ok(!forMeWithoutName(t), `не ему: ${t}`);
  assert.ok(isCommand('Привет, разберись с МТС Банком'));
  assert.ok(isQuestionForMe('А что у нас по МТС Банку?'));
});

test('после его вопроса: короткий ответ и ответ с просьбой — ему, болтовня — нет', () => {
  for (const t of ['да', 'давай', 'пока не надо', 'нет', 'да передай в радиосеть москва', 'возьми на меня', 'напиши руководителю что срок горит']) assert.ok(looksForMe(t), t);
  for (const t of ['лучше чем было но всё равно', 'ну это вообще другая история была']) assert.ok(!looksForMe(t), t);
});

test('эхо: его фраза из колонок — эхо; ответ со словами из вопроса — не эхо', () => {
  assert.ok(!isEcho('да передай в радиосеть москва', ASKED), 'ответ с повтором команды — не эхо');
  assert.ok(!isEcho('возьми инцидент мтс банк', ASKED), 'ответ с повтором сервиса — не эхо');
  assert.ok(!isEcho('передать', ASKED));
  assert.ok(isEcho('новый инцидент на распределение жалобы мтс банк', ASKED), 'кусок его реплики подряд');
  assert.ok(isEcho('жалобы мтс банк самарская область', ASKED));
  assert.ok(isEcho('ии советует радиосеть москва передать', ASKED));
});

test('перебили: «стоп» и своя речь — да; шум, эхо и одно слово — нет', () => {
  assert.equal(bargeIn('стоп', ASKED), 'stop');
  assert.equal(bargeIn('хватит', ASKED), 'stop');
  assert.equal(bargeIn('подожди лучше скажи что с почтой', ASKED), 'talk');
  assert.equal(bargeIn('нет не надо давай другую команду найди', ASKED), 'talk');
  assert.equal(bargeIn('инцидент на распределение', ASKED), null, 'эхо');
  assert.equal(bargeIn('мтс банк самара', ASKED), null, 'эхо с одной ошибкой распознавания');
  assert.equal(bargeIn('ну', ASKED), null, 'шум');
  assert.equal(bargeIn('а', ASKED), null);
  assert.equal(bargeIn('шшш ммм', ASKED), null);
});

test('повтор той же просьбы, пока он думает, — не выполняем второй раз', () => {
  assert.ok(sameRequest('что горит', 'что сейчас горит'));
  assert.ok(sameRequest('покажи почту', 'покажи почту пожалуйста'));
  assert.ok(!sameRequest('покажи почту', 'что с мтс банком'));
});

test('короткие команды окну на стене — сразу по правилам, без модели', () => {
  for (const t of ['покажи четыре группы', 'Четыре группы на весь экран', 'закрой окно', 'открой группы']) assert.ok(quickWall(t), t);
  for (const t of ['раскладка четыре группы', 'закрой настройки дашборда', 'что горит', 'кому передать']) assert.ok(!quickWall(t), t);
});

test('пауза — только по явной просьбе: «пока не надо» — ответ, а не «замолчи»', () => {
  for (const t of ['пока не надо', 'не надо', 'всё не надо']) assert.ok(!SLEEP_RE.test(t), t);
  for (const t of ['пауза', 'не мешай', 'отключись', 'выключи микрофон']) assert.ok(SLEEP_RE.test(t), t);
});
