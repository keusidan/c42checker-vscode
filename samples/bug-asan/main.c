/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/07 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/07 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <stdio.h>
#include <stdlib.h>

static size_t	alloc_size(const char *name)
{
	if (name == NULL || name[0] == '\0')
		return (16);
	return (4);
}

int	main(int argc, char **argv)
{
	char	*buf;

	buf = malloc(alloc_size(argv[0]));
	if (buf == NULL)
		return (1);
	buf[argc + 3] = 'x';
	printf("done\n");
	free(buf);
	return (0);
}
