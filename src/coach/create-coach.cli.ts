import "dotenv/config";
import { createInterface } from "node:readline";
import { PrismaService } from "../prisma/prisma.service";
import { createCoachAccount } from "./create-coach-account";

// Création du premier compte coach (et de son club) sur une base neuve :
//
//   npm run create:coach -- --email=coach@club.fr --prenom=Kaïs --nom=Dilmi \
//     --club="TKD Eaubonne" [--ville=Eaubonne] [--pays=France]
//
// Le mot de passe est demandé au clavier (jamais en argument : il finirait
// dans l'historique du shell).
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Argument invalide: ${arg}`);
    args[match[1]] = match[2];
  }
  for (const required of ["email", "prenom", "nom", "club"]) {
    if (!args[required]) throw new Error(`--${required}=... est obligatoire`);
  }
  return args;
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
  const args = parseArgs(process.argv.slice(2));
  const password = await askHidden("Mot de passe du coach : ");
  const confirmation = await askHidden("Confirmer le mot de passe : ");
  if (password !== confirmation) throw new Error("Les mots de passe ne correspondent pas");

  const prisma = new PrismaService();
  try {
    const result = await createCoachAccount(prisma, {
      email: args.email,
      password,
      prenom: args.prenom,
      nom: args.nom,
      clubName: args.club,
      clubVille: args.ville,
      clubPays: args.pays,
    });
    console.log(`Coach créé : ${result.email} (club « ${result.clubName} »)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => {
  console.error(`Échec : ${error.message}`);
  process.exitCode = 1;
});
