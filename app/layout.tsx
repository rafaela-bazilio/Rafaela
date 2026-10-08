import "./style.css";
export const metadata = {
  title: "QUEIROZ E ANDRADE ADVOGADOS",
  description: "Atendimento e relacionamento profissional",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
