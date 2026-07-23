import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCheck2,
  GitBranch,
  Headphones,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  MessageCircleMore,
  MessagesSquare,
  Network,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  UserCheck,
  UsersRound,
  Workflow,
} from 'lucide-react';
import styles from './crm.module.css';

export const metadata: Metadata = {
  title: {
    absolute: 'CRM NEXOR AI | Transforme conversas em operação comercial',
  },
  description:
    'Organize atendimento, contatos, oportunidades, campanhas e automações conectadas ao WhatsApp em uma operação comercial rastreável.',
  robots: {
    index: false,
    follow: false,
  },
};

const outcomes = [
  {
    icon: MessagesSquare,
    label: 'Atendimento',
    text: 'Histórico e contexto disponíveis para a equipe.',
  },
  {
    icon: Target,
    label: 'Vendas',
    text: 'Oportunidades com etapa, responsável e próximo passo.',
  },
  {
    icon: Workflow,
    label: 'Automação',
    text: 'Rotinas repetitivas executadas sob regras definidas.',
  },
  {
    icon: ShieldCheck,
    label: 'Gestão',
    text: 'Permissões, rastreabilidade e supervisão humana.',
  },
];

const operatingLayers = [
  {
    icon: MessageCircleMore,
    kicker: 'Relacionamento',
    title: 'Uma caixa de entrada que preserva o contexto',
    text: 'A equipe atende no mesmo ambiente, identifica responsáveis e acompanha o histórico sem depender de um único aparelho ou pessoa.',
    bullets: [
      'Conversas centralizadas',
      'Atribuição de responsável',
      'Histórico por contato',
    ],
    className: 'relationshipCard',
  },
  {
    icon: GitBranch,
    kicker: 'Operação comercial',
    title: 'Cada conversa pode avançar para uma oportunidade',
    text: 'Contatos e negócios deixam de ficar soltos. O pipeline mostra etapa, valor, responsável e o que precisa acontecer em seguida.',
    bullets: [
      'Pipeline em Kanban',
      'Negócios e etapas',
      'Campos e tags personalizados',
    ],
    className: 'salesCard',
  },
  {
    icon: Workflow,
    kicker: 'Escala controlada',
    title: 'Campanhas e automações sem perder governança',
    text: 'Fluxos, listas e mensagens são configurados sobre regras claras para reduzir trabalho repetitivo sem transformar a operação em disparo cego.',
    bullets: [
      'Cadência configurável',
      'Fluxos acionados por eventos',
      'Controle sobre mensagens',
    ],
    className: 'automationCard',
  },
  {
    icon: Bot,
    kicker: 'Inteligência aplicada',
    title: 'IA para ampliar contexto — não para remover responsabilidade',
    text: 'A assistência usa a base da conta para apoiar respostas e rotinas. O nível de autonomia e os pontos de revisão são definidos pela empresa.',
    bullets: ['Base de conhecimento', 'Revisão humana', 'Regras por operação'],
    className: 'aiCard',
  },
];

const implementationSteps = [
  {
    number: '01',
    icon: Search,
    title: 'Diagnóstico operacional',
    text: 'Mapeamos números, equipe, etapas comerciais, mensagens e gargalos antes de configurar a plataforma.',
  },
  {
    number: '02',
    icon: Network,
    title: 'Arquitetura do processo',
    text: 'Definimos pipeline, responsabilidades, permissões, cadências e automações adequadas ao fluxo real.',
  },
  {
    number: '03',
    icon: FileCheck2,
    title: 'Configuração e validação',
    text: 'A operação é configurada e testada com critérios claros antes de assumir rotinas do atendimento.',
  },
  {
    number: '04',
    icon: UserCheck,
    title: 'Acompanhamento da equipe',
    text: 'A implantação inclui orientação para uso, ajustes iniciais e evolução baseada na operação observada.',
  },
];

const faqs = [
  {
    question: 'O CRM substitui o WhatsApp da empresa?',
    answer:
      'Não. Ele organiza a operação conectada ao WhatsApp. O canal continua sendo usado pelo cliente, enquanto a equipe passa a trabalhar com histórico, contatos, responsáveis, oportunidades e regras em um ambiente estruturado.',
  },
  {
    question: 'A IA responde clientes sem aprovação?',
    answer:
      'Não por padrão. O nível de autonomia é definido na implantação. A IA pode sugerir respostas, consultar a base da conta e apoiar rotinas, mantendo revisão humana nos pontos que a empresa considerar sensíveis.',
  },
  {
    question: 'Serve somente para equipes de vendas?',
    answer:
      'Não. A plataforma atende operações que combinam relacionamento, atendimento e processo comercial. Ela é especialmente útil quando várias pessoas precisam compartilhar contexto e conduzir o próximo passo.',
  },
  {
    question: 'É possível usar mais de um número ou equipe?',
    answer:
      'A arquitetura prevê gestão por conta, equipe, funções e configurações de WhatsApp. A viabilidade e a forma correta de conexão são avaliadas durante o diagnóstico da implantação.',
  },
  {
    question: 'Como funciona a implantação?',
    answer:
      'A NEXOR primeiro entende o processo atual, depois configura contatos, pipeline, permissões, mensagens e automações. O objetivo é adaptar o CRM à operação real — não obrigar a empresa a copiar um modelo genérico.',
  },
];

export default function CrmLandingPage() {
  return (
    <main className={styles.page} lang="pt-BR">
      <header className={styles.header}>
        <Link
          className={styles.brand}
          href="/crm"
          aria-label="CRM NEXOR AI — início"
        >
          <span className={styles.logoFrame}>
            <Image
              src="/nexor-logo.png"
              alt="NEXOR AI"
              width={180}
              height={60}
              priority
            />
          </span>
          <span className={styles.productName}>CRM</span>
        </Link>

        <nav className={styles.nav} aria-label="Navegação principal">
          <a href="#operacao">A plataforma</a>
          <a href="#implantacao">Implantação</a>
          <a href="#governanca">Governança</a>
          <a href="#duvidas">Dúvidas</a>
        </nav>

        <div className={styles.headerActions}>
          <Link className={styles.loginLink} href="/login">
            Acessar
          </Link>
          <a
            className={styles.headerCta}
            href="https://www.nexoraisolutions.space/contato"
            target="_blank"
            rel="noreferrer"
          >
            <span className={styles.ctaDesktop}>Solicitar demonstração</span>
            <span className={styles.ctaMobile}>Demonstração</span>
            <ArrowRight size={15} aria-hidden="true" />
          </a>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span /> CRM operacional conectado ao WhatsApp
          </p>
          <h1>
            Atendimento organizado.
            <span> Vendas com processo.</span>
          </h1>
          <p className={styles.heroLead}>
            Transforme conversas dispersas em uma operação comercial com
            contexto, responsáveis, oportunidades e próximos passos visíveis
            para toda a equipe.
          </p>

          <div className={styles.heroActions}>
            <a
              className={styles.primaryButton}
              href="https://www.nexoraisolutions.space/contato"
              target="_blank"
              rel="noreferrer"
            >
              Solicitar uma demonstração
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className={styles.secondaryButton} href="#operacao">
              Ver como a operação funciona
            </a>
          </div>

          <p className={styles.heroQualifier}>
            Para empresas que atendem, qualificam e vendem pelo WhatsApp com
            mais de uma pessoa na operação.
          </p>
        </div>

        <div
          className={styles.productStage}
          role="img"
          aria-label="Demonstração visual do CRM NEXOR AI"
        >
          <div className={styles.stageGlow} aria-hidden="true" />
          <div className={styles.crmWindow}>
            <div className={styles.windowTopbar}>
              <div className={styles.windowBrand}>
                <span className={styles.mark}>N</span>
                <span>
                  <strong>NEXOR CRM</strong>
                  <small>Operação comercial</small>
                </span>
              </div>
              <div className={styles.windowSearch}>
                <Search size={13} aria-hidden="true" /> Buscar contato ou
                conversa
              </div>
              <span className={styles.onlineDot}>Canal demonstrativo</span>
            </div>

            <div className={styles.windowBody}>
              <aside
                className={styles.appSidebar}
                aria-label="Menu ilustrativo do CRM"
              >
                <span className={styles.activeNav}>
                  <MessageCircleMore size={16} /> Caixa de entrada
                </span>
                <span>
                  <UsersRound size={16} /> Contatos
                </span>
                <span>
                  <GitBranch size={16} /> Pipeline
                </span>
                <span>
                  <Send size={16} /> Campanhas
                </span>
                <span>
                  <Workflow size={16} /> Automações
                </span>
                <span>
                  <Bot size={16} /> Agente de IA
                </span>
              </aside>

              <div className={styles.conversationList}>
                <div className={styles.panelTitle}>
                  <div>
                    <strong>Conversas</strong>
                    <small>Atendimento da equipe</small>
                  </div>
                  <span>12 abertas</span>
                </div>
                <div
                  className={`${styles.conversation} ${styles.selectedConversation}`}
                >
                  <span className={styles.avatar}>MC</span>
                  <span>
                    <strong>Mariana Costa</strong>
                    <small>Quero entender a implantação...</small>
                  </span>
                  <time>agora</time>
                </div>
                <div className={styles.conversation}>
                  <span className={styles.avatar}>RA</span>
                  <span>
                    <strong>Rafael Alves</strong>
                    <small>Documento recebido. Obrigado!</small>
                  </span>
                  <time>8 min</time>
                </div>
                <div className={styles.conversation}>
                  <span className={styles.avatar}>LF</span>
                  <span>
                    <strong>Luana Ferreira</strong>
                    <small>Podemos falar amanhã?</small>
                  </span>
                  <time>22 min</time>
                </div>
                <div className={styles.conversation}>
                  <span className={styles.avatar}>GB</span>
                  <span>
                    <strong>Grupo Boreal</strong>
                    <small>Gostaria de uma proposta.</small>
                  </span>
                  <time>1 h</time>
                </div>
              </div>

              <div className={styles.chatPanel}>
                <div className={styles.chatHeader}>
                  <span className={styles.avatar}>MC</span>
                  <span>
                    <strong>Mariana Costa</strong>
                    <small>Oportunidade em qualificação</small>
                  </span>
                  <span className={styles.assigned}>Responsável: Anderson</span>
                </div>
                <div className={styles.contextBar}>
                  <span>
                    <BriefcaseBusiness size={11} /> Pipeline: Qualificação
                  </span>
                  <span>
                    <Clock3 size={11} /> Retorno: hoje
                  </span>
                </div>
                <div className={styles.messages}>
                  <div className={styles.receivedMessage}>
                    Nossa equipe atende em dois números. É possível manter o
                    histórico organizado?
                    <time>10:42</time>
                  </div>
                  <div className={styles.aiHint}>
                    <Sparkles size={14} aria-hidden="true" />
                    <span>
                      <strong>Contexto encontrado</strong>Sugestão preparada com
                      a base da conta. Revisão ilustrativa.
                    </span>
                  </div>
                  <div className={styles.sentMessage}>
                    Sim. Primeiro mapeamos números, responsáveis e regras para
                    estruturar o atendimento sem perder contexto.
                    <time>10:44 ✓✓</time>
                  </div>
                </div>
                <div className={styles.composer}>
                  <span>Escreva uma mensagem...</span>
                  <span className={styles.composerAction}>
                    <Send size={15} aria-hidden="true" />
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className={`${styles.floatingCard} ${styles.pipelineCard}`}>
            <span className={styles.floatIcon}>
              <GitBranch size={17} />
            </span>
            <span>
              <small>Oportunidade</small>
              <strong>Próximo passo definido</strong>
            </span>
            <CheckCircle2 size={18} aria-hidden="true" />
          </div>
          <div className={`${styles.floatingCard} ${styles.controlCard}`}>
            <span className={styles.floatIcon}>
              <ShieldCheck size={17} />
            </span>
            <span>
              <small>Governança</small>
              <strong>Revisão humana configurável</strong>
            </span>
          </div>
        </div>
      </section>

      <section
        className={styles.outcomeStrip}
        aria-label="Resultados operacionais da plataforma"
      >
        {outcomes.map((outcome) => {
          const Icon = outcome.icon;
          return (
            <article key={outcome.label}>
              <Icon size={20} aria-hidden="true" />
              <div>
                <strong>{outcome.label}</strong>
                <p>{outcome.text}</p>
              </div>
            </article>
          );
        })}
      </section>

      <section className={styles.problemSection}>
        <div className={styles.sectionHeading}>
          <p className={styles.sectionLabel}>O custo da operação fragmentada</p>
          <h2>
            O problema não é receber mensagens. É conduzir cada conversa até o
            próximo passo.
          </h2>
        </div>
        <div className={styles.problemContent}>
          <div className={styles.problemNarrative}>
            <p>
              Quando atendimento, histórico e vendas ficam espalhados entre
              celulares, planilhas e memória da equipe, a empresa perde
              continuidade antes mesmo de perder o cliente.
            </p>
            <div className={styles.problemList}>
              <span>
                <CircleDot size={14} /> O cliente repete informações para
                pessoas diferentes.
              </span>
              <span>
                <CircleDot size={14} /> Oportunidades ficam sem dono ou retorno
                definido.
              </span>
              <span>
                <CircleDot size={14} /> A gestão não enxerga o que está parado
                ou avançando.
              </span>
              <span>
                <CircleDot size={14} /> Automações são executadas sem contexto
                suficiente.
              </span>
            </div>
          </div>
          <aside className={styles.diagnosticCard}>
            <p>O CRM NEXOR organiza quatro perguntas em cada interação:</p>
            <ol>
              <li>
                <span>01</span> Quem é este contato?
              </li>
              <li>
                <span>02</span> O que já aconteceu?
              </li>
              <li>
                <span>03</span> Quem é o responsável?
              </li>
              <li>
                <span>04</span> Qual é o próximo passo?
              </li>
            </ol>
          </aside>
        </div>
      </section>

      <section className={styles.operatingSection} id="operacao">
        <div className={styles.sectionHeadingRow}>
          <div>
            <p className={styles.sectionLabel}>
              Uma camada operacional completa
            </p>
            <h2>
              Do atendimento à gestão, tudo trabalha sobre o mesmo contexto.
            </h2>
          </div>
          <p>
            A plataforma conecta as frentes que normalmente ficam isoladas — sem
            transformar o processo em uma sequência de ferramentas
            desconectadas.
          </p>
        </div>

        <div className={styles.operatingGrid}>
          {operatingLayers.map((layer) => {
            const Icon = layer.icon;
            return (
              <article
                key={layer.title}
                className={`${styles.operatingCard} ${styles[layer.className]}`}
              >
                <div className={styles.cardHeader}>
                  <span className={styles.cardIcon}>
                    <Icon size={22} aria-hidden="true" />
                  </span>
                  <span>{layer.kicker}</span>
                </div>
                <h3>{layer.title}</h3>
                <p>{layer.text}</p>
                <ul>
                  {layer.bullets.map((bullet) => (
                    <li key={bullet}>
                      <Check size={14} /> {bullet}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.audienceSection}>
        <div className={styles.audienceIntro}>
          <p className={styles.sectionLabel}>Para quem faz sentido</p>
          <h2>
            Uma operação profissional para empresas que já não cabem no
            improviso.
          </h2>
        </div>
        <div className={styles.audienceGrid}>
          <article>
            <Headphones size={25} aria-hidden="true" />
            <h3>Atendimento em equipe</h3>
            <p>
              Quando diferentes pessoas atendem o mesmo cliente e precisam
              compartilhar contexto.
            </p>
          </article>
          <article>
            <BriefcaseBusiness size={25} aria-hidden="true" />
            <h3>Venda consultiva</h3>
            <p>
              Quando a decisão exige acompanhamento, retorno, proposta e avanço
              por etapas.
            </p>
          </article>
          <article>
            <Building2 size={25} aria-hidden="true" />
            <h3>Operação em crescimento</h3>
            <p>
              Quando planilhas e celulares deixam de oferecer controle
              suficiente para a gestão.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.implementationSection} id="implantacao">
        <div className={styles.implementationIntro}>
          <p className={styles.sectionLabel}>Implantação NEXOR</p>
          <h2>
            O software é apenas uma parte. O valor está em organizar a operação.
          </h2>
          <p>
            A implantação parte do processo real da empresa. Não entregamos um
            painel vazio esperando que a equipe descubra sozinha como trabalhar.
          </p>
        </div>

        <div className={styles.implementationRail}>
          {implementationSteps.map((step, index) => {
            const Icon = step.icon;
            return (
              <article key={step.number}>
                <div className={styles.stepTop}>
                  <span>{step.number}</span>
                  <Icon size={21} aria-hidden="true" />
                </div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                {index < implementationSteps.length - 1 && (
                  <ChevronRight
                    className={styles.stepArrow}
                    size={20}
                    aria-hidden="true"
                  />
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.governanceSection} id="governanca">
        <div className={styles.governanceCopy}>
          <p className={styles.sectionLabel}>Governança por desenho</p>
          <h2>IA e automação com limites claros para a operação.</h2>
          <p className={styles.governanceLead}>
            O CRM foi estruturado para combinar velocidade com responsabilidade.
            A empresa define quem acessa, o que pode ser automatizado e onde a
            revisão humana deve permanecer no processo.
          </p>
          <div className={styles.governanceChecks}>
            <span>
              <KeyRound size={16} />
              <strong>Configuração de permissões por função</strong>
            </span>
            <span>
              <LockKeyhole size={16} />
              <strong>Integrações definidas na implantação</strong>
            </span>
            <span>
              <FileCheck2 size={16} />
              <strong>Recursos de histórico e rastreabilidade</strong>
            </span>
            <span>
              <UserCheck size={16} />
              <strong>Pontos de revisão humana configuráveis</strong>
            </span>
          </div>
        </div>

        <div
          className={styles.controlPanel}
          aria-label="Painel ilustrativo de governança"
        >
          <div className={styles.controlPanelHeader}>
            <div>
              <ShieldCheck size={20} />
              <span>
                <strong>Controles da operação</strong>
                <small>Opções de configuração</small>
              </span>
            </div>
            <span className={styles.secureBadge}>Definido na implantação</span>
          </div>
          <div className={styles.controlRows}>
            <div>
              <span className={styles.controlIcon}>
                <UserCheck size={17} />
              </span>
              <span>
                <strong>Aprovação humana</strong>
                <small>Pode ser exigida nas ações definidas pela empresa</small>
              </span>
              <em>Configurável</em>
            </div>
            <div>
              <span className={styles.controlIcon}>
                <Bot size={17} />
              </span>
              <span>
                <strong>Assistência de IA</strong>
                <small>Pode utilizar a base de conhecimento da conta</small>
              </span>
              <em>Configurável</em>
            </div>
            <div>
              <span className={styles.controlIcon}>
                <Send size={17} />
              </span>
              <span>
                <strong>Campanhas</strong>
                <small>
                  Cadência e limites definidos durante a configuração
                </small>
              </span>
              <em>Configurável</em>
            </div>
            <div>
              <span className={styles.controlIcon}>
                <LayoutDashboard size={17} />
              </span>
              <span>
                <strong>Rastreabilidade</strong>
                <small>Recursos de eventos e histórico operacional</small>
              </span>
              <em>Conforme configuração</em>
            </div>
          </div>
          <div className={styles.controlFooter}>
            <CheckCircle2 size={16} /> A operação mantém responsabilidade humana
            sobre as decisões críticas definidas na implantação.
          </div>
        </div>
      </section>

      <section className={styles.faqSection} id="duvidas">
        <div className={styles.faqIntro}>
          <p className={styles.sectionLabel}>Perguntas frequentes</p>
          <h2>O que você precisa saber antes de avaliar a plataforma.</h2>
          <p>
            Sem promessas genéricas. A adequação depende do processo, da equipe
            e do objetivo operacional da empresa.
          </p>
        </div>
        <div className={styles.faqList}>
          {faqs.map((faq, index) => (
            <details
              key={faq.question}
              className={styles.faqItem}
              open={index === 0}
            >
              <summary>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {faq.question}
                <span className={styles.faqPlus} aria-hidden="true">
                  +
                </span>
              </summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className={styles.finalCta}>
        <div className={styles.ctaCopy}>
          <p className={styles.sectionLabel}>Próximo passo</p>
          <h2>Veja como o CRM pode organizar a sua operação comercial.</h2>
          <p>
            Em uma demonstração, a NEXOR apresenta a plataforma e identifica
            quais partes do atendimento, vendas e automação precisam ser
            estruturadas no seu cenário.
          </p>
          <div className={styles.ctaActions}>
            <a
              className={styles.ctaButton}
              href="https://www.nexoraisolutions.space/contato"
              target="_blank"
              rel="noreferrer"
            >
              Solicitar demonstração
              <ArrowRight size={18} aria-hidden="true" />
            </a>
            <span>Conversa inicial sem compromisso de implantação.</span>
          </div>
        </div>
        <div className={styles.ctaSeal} aria-hidden="true">
          <span>N</span>
          <small>
            Inteligência aplicada
            <br />à operação
          </small>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <span className={styles.logoFrame}>
            <Image
              src="/nexor-logo.png"
              alt="NEXOR AI"
              width={170}
              height={56}
            />
          </span>
          <p>Consultoria, arquitetura operacional e agentes especializados.</p>
        </div>
        <div className={styles.footerLinks}>
          <a href="#operacao">Plataforma</a>
          <a href="#implantacao">Implantação</a>
          <a href="#governanca">Governança</a>
          <Link href="/login">Acessar CRM</Link>
        </div>
        <p className={styles.copyright}>
          © 2026 NEXOR AI. Inteligência aplicada à operação.
        </p>
      </footer>
    </main>
  );
}
