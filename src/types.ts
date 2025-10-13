export type IpPort = {
	ip: string;
	port: number;
};

export type Progress = {
	current: number;
	total: number;
};

export type ProgressCallback = (progress: Progress) => void;