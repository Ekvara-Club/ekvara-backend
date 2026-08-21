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
}

export interface ImportFetchResult {
  detected: number;
  competitions: ImportedCompetition[];
  failed: number;
}
