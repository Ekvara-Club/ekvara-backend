export interface ImportedCompetition {
  source: string;
  sourceExternalId: string;
  nom: string;
  dateDebut: Date;
  dateFin?: Date;
  lieu?: string;
  ville?: string;
  pays?: string;
  organisateur?: string;
  niveau?: string;
  // Lignes Date/Discipline du calendrier WT (seule source qui les publie) :
  // absent pour les autres importeurs, qui ne touchent donc jamais
  // competition_source.raw_divisions.
  divisions?: CalendarDivision[];
}

export interface CalendarDivision {
  dateText: string;
  discipline: string | null;
  start: string | null; // AAAA-MM-JJ
  end: string | null;
}

export interface ImportFetchResult {
  detected: number;
  competitions: ImportedCompetition[];
  failed: number;
}
