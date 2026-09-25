# CRM GRAVV

Central da GRAVV (clientes, comercial, projetos, tarefas, financeiro, leads do site e conversas do WhatsApp).

- Online: https://crm.gravv.com.br
- Hospedagem: Vercel (projeto `gravv-crm`), com deploy automático a cada commit na `main`.
- Banco: Supabase (tabelas `crm_eventos`, `crm_leads`, `wa_mensagens`).
- Segredos ficam só nas variáveis de ambiente da Vercel, nunca no código.
