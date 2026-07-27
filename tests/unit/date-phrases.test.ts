import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDatePhrase, findDateInText } from '../../src/ai/date-phrases.js';

/** 2026-07-26 é um domingo. Facilita conferir os dias da semana. */
const REF = '2026-07-26';

const resolve = (phrase: string): string | null => resolveDatePhrase(phrase, REF)?.date ?? null;

describe('referências simples', () => {
  test('hoje, ontem, anteontem, amanhã', () => {
    assert.equal(resolve('hoje'), '2026-07-26');
    assert.equal(resolve('ontem'), '2026-07-25');
    assert.equal(resolve('anteontem'), '2026-07-24');
    assert.equal(resolve('amanhã'), '2026-07-27');
    assert.equal(resolve('depois de amanhã'), '2026-07-28');
  });

  test('ignora acento e caixa', () => {
    assert.equal(resolve('ONTEM'), '2026-07-25');
    assert.equal(resolve('  Amanha  '), '2026-07-27');
  });
});

describe('datas explícitas', () => {
  test('formato ISO passa direto', () => {
    assert.equal(resolve('2026-03-15'), '2026-03-15');
  });

  test('formato brasileiro', () => {
    assert.equal(resolve('15/03/2026'), '2026-03-15');
    assert.equal(resolve('5/3/2026'), '2026-03-05');
    assert.equal(resolve('15/03/26'), '2026-03-15');
  });

  test('sem ano, assume o ano corrente', () => {
    assert.equal(resolve('15/03'), '2026-03-15');
  });

  test('sem ano e no futuro, assume o ano passado', () => {
    // "gastei em 28/12" dito em julho: foi dezembro passado, não o que vem.
    assert.equal(resolve('28/12'), '2025-12-28');
  });

  test('dia 31 em mês curto é encaixado', () => {
    assert.equal(resolve('31/02/2026'), '2026-02-28');
  });
});

describe('dias da semana', () => {
  test('sem modificador, pega a ocorrência mais recente no passado', () => {
    // Referência é domingo (26/07). A sexta anterior foi 24/07.
    assert.equal(resolve('sexta'), '2026-07-24');
    assert.equal(resolve('segunda'), '2026-07-20');
    assert.equal(resolve('sabado'), '2026-07-25');
  });

  test('"passada" tem o mesmo efeito', () => {
    assert.equal(resolve('sexta passada'), '2026-07-24');
    assert.equal(resolve('segunda passada'), '2026-07-20');
  });

  test('o mesmo dia da semana da referência volta uma semana', () => {
    // Hoje é domingo; "domingo" não pode ser hoje, senão "gastei domingo" ficaria ambíguo.
    assert.equal(resolve('domingo'), '2026-07-19');
  });

  test('"que vem" olha para o futuro', () => {
    assert.equal(resolve('sexta que vem'), '2026-07-31');
    assert.equal(resolve('proxima segunda'), '2026-07-27');
  });

  test('"retrasada" volta duas semanas', () => {
    assert.equal(resolve('sexta retrasada'), '2026-07-17');
  });

  test('aceita a forma com -feira', () => {
    assert.equal(resolve('sexta-feira'), '2026-07-24');
  });

  test('aceita preposição', () => {
    assert.equal(resolve('na sexta'), '2026-07-24');
    assert.equal(resolve('no sabado'), '2026-07-25');
  });
});

describe('dia do mês', () => {
  test('dia já passado neste mês', () => {
    assert.equal(resolve('dia 5'), '2026-07-05');
    assert.equal(resolve('dia 20'), '2026-07-20');
  });

  test('dia futuro neste mês vira mês passado', () => {
    // "paguei dia 30" dito no dia 26: foi o dia 30 do mês passado.
    assert.equal(resolve('dia 30'), '2026-06-30');
  });

  test('com mês nomeado', () => {
    assert.equal(resolve('dia 10 de março'), '2026-03-10');
    assert.equal(resolve('dia 3 de jan'), '2026-01-03');
  });

  test('mês nomeado no futuro vira ano passado', () => {
    assert.equal(resolve('dia 10 de dezembro'), '2025-12-10');
  });
});

describe('intervalos relativos', () => {
  test('há N dias/semanas/meses', () => {
    assert.equal(resolve('há 3 dias'), '2026-07-23');
    assert.equal(resolve('ha 2 semanas'), '2026-07-12');
    assert.equal(resolve('há 1 mes'), '2026-06-26');
    assert.equal(resolve('faz 10 dias'), '2026-07-16');
  });

  test('em N dias', () => {
    assert.equal(resolve('em 5 dias'), '2026-07-31');
    assert.equal(resolve('daqui a 2 semanas'), '2026-08-09');
  });

  test('períodos', () => {
    assert.equal(resolve('semana passada'), '2026-07-19');
    assert.equal(resolve('mes passado'), '2026-06-26');
    assert.equal(resolve('inicio do mes'), '2026-07-01');
    assert.equal(resolve('fim do mes'), '2026-07-31');
  });
});

describe('não reconhecido', () => {
  test('devolve null em vez de adivinhar', () => {
    // Adivinhar uma data errada num lançamento financeiro é pior que não saber.
    assert.equal(resolve('qualquer coisa'), null);
    assert.equal(resolve(''), null);
    assert.equal(resolveDatePhrase(null, REF), null);
    assert.equal(resolveDatePhrase(undefined, REF), null);
  });
});

describe('interpretação explicável', () => {
  test('devolve como entendeu, para a IA poder justificar', () => {
    assert.equal(resolveDatePhrase('ontem', REF)?.interpretation, 'ontem');
    assert.equal(resolveDatePhrase('sexta passada', REF)?.interpretation, 'sexta passada');
    assert.equal(resolveDatePhrase('dia 30', REF)?.interpretation, 'dia 30 do mês passado');
    assert.equal(resolveDatePhrase('28/12', REF)?.interpretation, '28/12 do ano passado (a data deste ano ainda não chegou)');
  });
});

describe('extração de texto livre', () => {
  test('encontra a data no meio da frase', () => {
    assert.equal(findDateInText('gastei 45 no mercado ontem', REF)?.date, '2026-07-25');
    assert.equal(findDateInText('paguei o aluguel dia 5', REF)?.date, '2026-07-05');
    assert.equal(findDateInText('jantar na sexta passada com amigos', REF)?.date, '2026-07-24');
    assert.equal(findDateInText('compra de 15/03', REF)?.date, '2026-03-15');
    assert.equal(findDateInText('recebi há 3 dias', REF)?.date, '2026-07-23');
  });

  test('devolve null quando não há data no texto', () => {
    assert.equal(findDateInText('gastei 45 no mercado', REF), null);
  });
});
