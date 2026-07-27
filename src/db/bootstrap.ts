/**
 * Dados iniciais de um banco novo: linha de configuração e árvore de categorias.
 *
 * As categorias vêm prontas e realistas para o contexto brasileiro porque
 * categorizar do zero é o atrito que faz a pessoa desistir do app na primeira
 * semana. São marcadas com `isSystem` — podem ser renomeadas ou arquivadas, mas
 * não apagadas, para não deixar transações órfãs.
 *
 * Idempotente: rodar de novo não duplica nada.
 */

import { eq } from 'drizzle-orm';
import { getDb, type Db } from './client.js';
import { categories, settings } from './schema.js';
import type { CategoryKind } from './schema.js';
import { mutate } from '../mutate/index.js';
import { env } from '../config/env.js';

interface CategorySeed {
  name: string;
  icon?: string;
  children?: string[];
}

const EXPENSE_CATEGORIES: CategorySeed[] = [
  {
    name: 'Moradia',
    icon: 'house',
    children: ['Aluguel', 'Financiamento', 'Condomínio', 'Luz', 'Água', 'Gás', 'Internet', 'IPTU', 'Manutenção'],
  },
  {
    name: 'Alimentação',
    icon: 'utensils',
    children: ['Supermercado', 'Restaurante', 'Delivery', 'Padaria', 'Café', 'Feira'],
  },
  {
    name: 'Transporte',
    icon: 'car',
    children: [
      'Combustível',
      'Aplicativo de transporte',
      'Transporte público',
      'Estacionamento',
      'Manutenção do veículo',
      'IPVA e licenciamento',
      'Seguro do veículo',
      'Pedágio',
    ],
  },
  {
    name: 'Saúde',
    icon: 'heart-pulse',
    children: ['Plano de saúde', 'Farmácia', 'Consultas', 'Exames', 'Dentista', 'Terapia', 'Academia'],
  },
  { name: 'Educação', icon: 'graduation-cap', children: ['Mensalidade', 'Cursos', 'Livros', 'Material'] },
  {
    name: 'Lazer',
    icon: 'party-popper',
    children: ['Streaming', 'Cinema', 'Bares', 'Viagens', 'Jogos', 'Hobbies', 'Eventos'],
  },
  { name: 'Compras', icon: 'shopping-bag', children: ['Roupas', 'Eletrônicos', 'Casa e decoração', 'Presentes'] },
  { name: 'Cuidados pessoais', icon: 'sparkles', children: ['Cabelo', 'Cosméticos', 'Vestuário'] },
  { name: 'Serviços', icon: 'wrench', children: ['Assinaturas', 'Telefonia', 'Software', 'Serviços domésticos'] },
  {
    name: 'Impostos e tarifas',
    icon: 'landmark',
    children: ['Tarifas bancárias', 'Impostos', 'Juros e multas', 'Anuidade de cartão'],
  },
  { name: 'Pets', icon: 'paw-print', children: ['Ração', 'Veterinário', 'Banho e tosa'] },
  { name: 'Família', icon: 'users', children: ['Filhos', 'Escola', 'Mesada'] },
  { name: 'Dívidas', icon: 'file-minus', children: ['Empréstimo', 'Parcelamento', 'Cartão de crédito'] },
  { name: 'Doações', icon: 'hand-heart' },
  { name: 'Outros', icon: 'circle-ellipsis' },
];

const INCOME_CATEGORIES: CategorySeed[] = [
  { name: 'Salário', icon: 'wallet', children: ['Salário', '13º salário', 'Férias', 'Bônus'] },
  { name: 'Trabalho autônomo', icon: 'briefcase', children: ['Freelance', 'Prestação de serviço', 'Vendas'] },
  { name: 'Investimentos', icon: 'trending-up', children: ['Dividendos', 'Juros', 'Resgate', 'Aluguel recebido'] },
  { name: 'Outras entradas', icon: 'plus-circle', children: ['Reembolso', 'Presente', 'Restituição', 'Empréstimo recebido'] },
];

/** Cria a linha única de configuração, se ainda não existir. */
export function ensureSettings(db: Db = getDb()): void {
  const existing = db.select().from(settings).where(eq(settings.id, 'singleton')).all();
  if (existing.length > 0) return;

  db.insert(settings)
    .values({
      id: 'singleton',
      timezone: env.TZ,
      aiModel: env.AI_MODEL,
    })
    .run();
}

export interface BootstrapResult {
  settingsCreated: boolean;
  categoriesCreated: number;
}

/**
 * Prepara um banco novo para uso. Seguro chamar em toda partida.
 */
export function bootstrap(db: Db = getDb()): BootstrapResult {
  const settingsBefore = db.select().from(settings).all().length;
  ensureSettings(db);
  const settingsCreated = settingsBefore === 0;

  const existingCategories = db.select().from(categories).all();
  if (existingCategories.length > 0) {
    return { settingsCreated, categoriesCreated: 0 };
  }

  const { result } = mutate(
    { source: 'seed', actor: 'system', summary: 'Criou categorias padrão', db },
    (ctx) => {
      let created = 0;
      let order = 0;

      const insertTree = (seeds: CategorySeed[], kind: CategoryKind): void => {
        for (const seed of seeds) {
          order += 1;
          const parent = ctx.insert<{ id: string }>('categories', {
            name: seed.name,
            kind,
            icon: seed.icon ?? null,
            isSystem: true,
            sortOrder: order,
          });
          created += 1;

          for (const [index, childName] of (seed.children ?? []).entries()) {
            ctx.insert('categories', {
              name: childName,
              kind,
              parentId: parent.id,
              isSystem: true,
              sortOrder: index + 1,
            });
            created += 1;
          }
        }
      };

      insertTree(EXPENSE_CATEGORIES, 'expense');
      insertTree(INCOME_CATEGORIES, 'income');

      ctx.setSummary(`Criou ${created} categorias padrão`);
      return created;
    },
  );

  return { settingsCreated, categoriesCreated: result };
}
