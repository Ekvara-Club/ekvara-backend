import "dotenv/config";
import { createInterface } from "node:readline";
import { PrismaService } from "../prisma/prisma.service";
import { resetPassword } from "./reset-password";

// Réinitialisation d'un mot de passe par l'administrateur (athlète ou coach) :
//
//   npm run reset:password -- --email=athlete@club.fr
//
// Le nouveau mot de passe est demandé au clavier (jamais en argument) ;
// transmets-le ensuite à la personne, qui pourra se connecter avec.
function parseEmail(argv: string[]): string {
  const arg = argv.find((a) => a.startsWith("--email="));
  if (!arg || argv.length !== 1) throw new Error("Usage : npm run reset:password -- --email=adresse@exemple.fr");
  return arg.slice("--email=".length);
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    output._writeToOutput = (s: string) => {
      if (!prompted) {
        output.output.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const email = parseEmail(process.argv.slice(2));
  const password = await askHidden("Nouveau mot de passe : ");
  const confirmation = await askHidden("Confirmer le mot de passe : ");
  if (password !== confirmation) throw new Error("Les mots de passe ne correspondent pas");

  const prisma = new PrismaService();
  try {
    const result = await resetPassword(prisma, email, password);
    console.log(`Mot de passe réinitialisé pour ${result.email}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => {
  console.error(`Échec : ${error.message}`);
  process.exitCode = 1;
});
